import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { ServiceError } from './schema.ts';
import type { Config, CreateTask, Device, FinishTask, MemoryFile, Task } from './schema.ts';

export type Event = { seq: number; kind: string; resource: string; at: number };

export class Store {
  db: DatabaseSync;
  config: Config;
  now: () => number;

  constructor(config: Config, now = Date.now) {
    this.config = config;
    this.now = now;
    if (config.database !== ':memory:') mkdirSync(dirname(config.database), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(config.database);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY, sender TEXT NOT NULL, request_id TEXT NOT NULL,
        executor TEXT NOT NULL, body TEXT NOT NULL, UNIQUE(sender, request_id)
      );
      CREATE INDEX IF NOT EXISTS tasks_executor ON tasks(executor);
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, device TEXT NOT NULL,
        kind TEXT NOT NULL, resource TEXT NOT NULL, at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_device_seq ON events(device, seq);
      CREATE TABLE IF NOT EXISTS presence (device TEXT PRIMARY KEY, seen INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS memory (
        path TEXT PRIMARY KEY, version INTEGER NOT NULL, content TEXT,
        updated_by TEXT NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS memory_versions (
        path TEXT NOT NULL, version INTEGER NOT NULL, content TEXT,
        updated_by TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(path,version)
      );
      INSERT OR IGNORE INTO memory_versions SELECT * FROM memory;
    `);
    // A restart cannot prove that any previous connection is still alive.
    this.db.exec('DELETE FROM presence');
  }

  close() { this.db.close(); }

  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  event(devices: string[], kind: string, resource: string) {
    const insert = this.db.prepare('INSERT INTO events(device, kind, resource, at) VALUES (?, ?, ?, ?)');
    for (const device of new Set(devices)) insert.run(device, kind, resource, this.now());
  }

  events(device: Device, after: number): Event[] {
    return this.db.prepare(`SELECT seq, kind, resource, at FROM events WHERE device = ? AND seq > ?
      AND (((kind LIKE 'task.%' OR kind LIKE 'hub.%') AND ? = 1) OR (kind LIKE 'memory.%' AND ? = 1)) ORDER BY seq LIMIT 100`)
      .all(device.id, after, Number(this.config.services.includes('tasks')),
        Number(device.memory && this.config.services.includes('memory'))) as Event[];
  }

  heartbeat(device: Device) {
    this.db.prepare('INSERT INTO presence VALUES (?, ?) ON CONFLICT(device) DO UPDATE SET seen = excluded.seen')
      .run(device.id, this.now());
    return { device: device.id, seenAt: this.now() };
  }

  online(device: string) {
    const row = this.db.prepare('SELECT seen FROM presence WHERE device = ?').get(device) as { seen: number } | undefined;
    return Boolean(row && this.now() - row.seen < 45_000);
  }

  readTask(taskId: string): Task {
    const row = this.db.prepare('SELECT body FROM tasks WHERE id = ?').get(taskId) as { body: string } | undefined;
    if (!row) throw new ServiceError(404, 'Task not found');
    return JSON.parse(row.body);
  }

  task(device: Device, taskId: string) {
    const task = this.readTask(taskId);
    if (device.id !== task.sender && device.id !== task.executor) throw new ServiceError(404, 'Task not found');
    return { ...task, executorOnline: this.online(task.executor),
      executionUnknown: task.status === 'running' && (!this.online(task.executor) || this.now() - task.updatedAt >= 45_000) };
  }

  tasks(device: Device, after = 0) {
    const rows = this.db.prepare(`SELECT rowid AS cursor, id FROM tasks
      WHERE (sender = ? OR executor = ?) AND rowid > ? ORDER BY rowid LIMIT 100`)
      .all(device.id, device.id, after) as { cursor: number; id: string }[];
    return { tasks: rows.map(row => this.task(device, row.id)), nextCursor: rows.at(-1)?.cursor ?? after };
  }

  create(device: Device, input: CreateTask) {
    if (!device.publishTo.includes(input.mailbox)) throw new ServiceError(403, 'Mailbox not allowed');
    return this.transaction(() => {
      const existing = this.db.prepare('SELECT body FROM tasks WHERE sender = ? AND request_id = ?')
        .get(device.id, input.requestId) as { body: string } | undefined;
      if (existing) {
        const task: Task = JSON.parse(existing.body);
        if (task.mailbox !== input.mailbox || task.title !== input.title || task.instructions !== input.instructions) {
          throw new ServiceError(409, 'requestId already used with different task content');
        }
        return this.task(device, task.id);
      }
      const executor = this.config.mailboxes[input.mailbox];
      if (!executor) throw new ServiceError(404, 'Unknown mailbox');
      const task: Task = { ...input, id: randomUUID(), sender: device.id, executor, status: 'queued',
        executionId: null, progress: null, result: null, createdAt: this.now(), updatedAt: this.now() };
      this.db.prepare('INSERT INTO tasks VALUES (?, ?, ?, ?, ?)')
        .run(task.id, task.sender, input.requestId, executor, JSON.stringify(task));
      this.event([task.sender, executor], 'task.created', task.id);
      return this.task(device, task.id);
    });
  }

  save(task: Task, kind: string) {
    task.updatedAt = this.now();
    this.db.prepare('UPDATE tasks SET body = ? WHERE id = ?').run(JSON.stringify(task), task.id);
    this.event([task.sender, task.executor], kind, task.id);
    return task;
  }

  owned(device: Device, taskId: string) {
    const task = this.readTask(taskId);
    if (task.executor !== device.id) throw new ServiceError(403, 'Only the assigned executor can update this task');
    return task;
  }

  claim(device: Device, taskId: string, executionId: string) {
    return this.transaction(() => {
      const task = this.owned(device, taskId);
      if (task.executionId === executionId) return task;
      if (task.status !== 'queued') throw new ServiceError(409, 'Task already claimed; do not start another execution');
      task.status = 'running';
      task.executionId = executionId;
      return this.save(task, 'task.claimed');
    });
  }

  progress(device: Device, taskId: string, executionId: string, message: string) {
    return this.transaction(() => {
      const task = this.owned(device, taskId);
      if (task.status !== 'running' || task.executionId !== executionId) throw new ServiceError(409, 'Execution mismatch');
      if (task.progress === message) {
        task.updatedAt = this.now();
        this.db.prepare('UPDATE tasks SET body = ? WHERE id = ?').run(JSON.stringify(task), task.id);
        return task;
      }
      task.progress = message;
      return this.save(task, 'task.progress');
    });
  }

  finish(device: Device, taskId: string, input: FinishTask) {
    return this.transaction(() => {
      const task = this.owned(device, taskId);
      if (task.executionId !== input.executionId) throw new ServiceError(409, 'Execution mismatch');
      if (task.status === input.status && task.result === input.result) return task;
      if (task.status !== 'running') throw new ServiceError(409, 'Task is not running');
      task.status = input.status;
      task.result = input.result;
      return this.save(task, 'task.finished');
    });
  }

  requireMemory(device: Device) {
    if (!device.memory) throw new ServiceError(403, 'Shared memory access not allowed');
  }

  memoryFiles(device: Device): MemoryFile[] {
    this.requireMemory(device);
    return this.db.prepare(`SELECT path, version, content, updated_by AS updatedBy, updated_at AS updatedAt
      FROM memory ORDER BY path`).all() as MemoryFile[];
  }

  memoryFile(device: Device, path: string): MemoryFile | null {
    this.requireMemory(device);
    return this.db.prepare(`SELECT path, version, content, updated_by AS updatedBy, updated_at AS updatedAt
      FROM memory WHERE path = ?`).get(path) as MemoryFile | undefined ?? null;
  }

  writeMemory(device: Device, path: string, baseVersion: number, content: string | null, withinTransaction = false) {
    this.requireMemory(device);
    const write = () => {
      const old = this.memoryFile(device, path);
      if ((old?.version ?? 0) !== baseVersion) {
        // A lost response can safely retry an identical write without incrementing the version.
        if (old && old.version === baseVersion + 1 && old.content === content && old.updatedBy === device.id) return old;
        throw new ServiceError(409, 'Memory version conflict; preserve both copies and reconcile');
      }
      const usage = this.db.prepare('SELECT COUNT(*) AS count, COALESCE(SUM(length(CAST(content AS BLOB))), 0) AS bytes FROM memory')
        .get() as { count: number; bytes: number };
      if ((!old && usage.count >= 1000) || usage.bytes - Buffer.byteLength(old?.content ?? '') + Buffer.byteLength(content ?? '') > 32 * 1024 * 1024) {
        throw new ServiceError(413, 'Shared memory quota exceeded (1000 paths / 32 MiB)');
      }
      const file: MemoryFile = { path, version: baseVersion + 1, content, updatedBy: device.id, updatedAt: this.now() };
      this.db.prepare('INSERT INTO memory_versions VALUES (?,?,?,?,?)').run(path, file.version, content, file.updatedBy, file.updatedAt);
      this.db.prepare(`INSERT INTO memory VALUES (?, ?, ?, ?, ?) ON CONFLICT(path) DO UPDATE SET
        version = excluded.version, content = excluded.content, updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
        .run(path, file.version, content, file.updatedBy, file.updatedAt);
      this.event(this.config.devices.filter(d => d.memory).map(d => d.id), 'memory.changed', path);
      return file;
    };
    return withinTransaction ? write() : this.transaction(write);
  }
}
