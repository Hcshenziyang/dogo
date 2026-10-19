import { randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';
import { memoryPath, memoryWriteSchema, ServiceError } from './schema.ts';
import type { Device } from './schema.ts';
import type { Store } from './store.ts';

const uuid = z.string().uuid();
export const memoryOps = {
  list: z.object({}).strict(),
  read: z.object({ path: memoryPath }).strict(),
  write: memoryWriteSchema,
  conflicts: z.object({}).strict(),
  conflict: z.object({ path: memoryPath, baseVersion: z.number().int().nonnegative(), local: z.string().max(256000).nullable() }).strict(),
  claim: z.object({ id: uuid, executionId: uuid }).strict(),
  resolve: z.object({ id: uuid, executionId: uuid.optional(), version: z.number().int().nonnegative(), content: z.string().max(256000).nullable(), reason: z.string().max(4000) }).strict(),
  defer: z.object({ id: uuid, executionId: uuid, reason: z.string().max(4000) }).strict(),
  versions: z.object({ path: memoryPath, before: z.number().int().positive().optional() }).strict(),
  policy: z.object({}).strict(),
  configurePolicy: z.object({ primary: z.string().max(100).nullable(), backup: z.string().max(100).nullable(), automatic: z.boolean() }).strict(),
  rename: z.object({ path: memoryPath, target: memoryPath, baseVersion: z.number().int().nonnegative() }).strict(),
  restore: z.object({ path: memoryPath, version: z.number().int().positive(), baseVersion: z.number().int().nonnegative() }).strict(),
};

export class MemoryService {
  store: Store;
  constructor(store: Store) {
    this.store = store;
    store.db.exec(`CREATE TABLE IF NOT EXISTS memory_conflicts (id TEXT PRIMARY KEY, body TEXT NOT NULL);`);
    store.db.exec(`CREATE TABLE IF NOT EXISTS memory_policy (id INTEGER PRIMARY KEY CHECK(id=1), body TEXT NOT NULL);`);
  }
  policy() { const row = this.store.db.prepare('SELECT body FROM memory_policy WHERE id=1').get(); return row ? JSON.parse(row.body as string) : { primary: null, backup: null, automatic: true }; }
  maintenanceDevice(device: Device) {
    const policy = this.policy(); if (!policy.automatic) return false;
    if (!policy.primary) return true;
    const primary = this.store.config.devices.find(d => d.id === policy.primary && d.memory);
    return device.id === policy.primary || (device.id === policy.backup && (!primary || !this.store.online(primary.id)));
  }
  conflicts() { return this.store.db.prepare('SELECT body FROM memory_conflicts ORDER BY rowid').all().map(row => JSON.parse(row.body as string)); }
  get(id: string) { const found = this.conflicts().find(c => c.id === id); if (!found) throw new ServiceError(404, 'Conflict not found'); return found; }
  save(conflict: any) {
    conflict.updatedAt = this.store.now();
    this.store.db.prepare('INSERT INTO memory_conflicts VALUES (?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(conflict.id, JSON.stringify(conflict));
    this.store.event(this.store.config.devices.filter(d => d.memory).map(d => d.id), 'memory.conflict', conflict.id);
    return conflict;
  }
  conflict(device: Device, input: { path: string; baseVersion: number; local: string | null }) {
    const current = this.store.memoryFile(device, input.path);
    const previous = this.conflicts().find(c => c.path === input.path && c.source === device.id && c.baseVersion === input.baseVersion && c.local === input.local && c.remoteVersion === (current?.version ?? 0));
    if (previous) return previous;
    const base = input.baseVersion === 0 ? { content: null } : this.store.db.prepare('SELECT content FROM memory_versions WHERE path = ? AND version = ?').get(input.path, input.baseVersion);
    return this.save({ id: randomUUID(), path: input.path, source: device.id, baseVersion: input.baseVersion, base: base?.content ?? null, baseKnown: !!base,
      local: input.local, remote: current?.content ?? null, remoteVersion: current?.version ?? 0,
      status: base ? 'pending' : 'needs-human', executionId: null, claimedBy: null, attempts: 0, createdAt: this.store.now(), reason: base ? '' : '基准版本不可用，保留双方供人工处理' });
  }
  execute(device: Device, op: string, value: unknown): any {
    if (!this.store.config.services.includes('memory')) throw new ServiceError(404, 'Memory service disabled');
    this.store.requireMemory(device);
    if (!Object.hasOwn(memoryOps, op)) throw new ServiceError(404, 'Unknown memory operation');
    const input = memoryOps[op as keyof typeof memoryOps].parse(value) as any;
    switch (op) {
      case 'policy': return { ...this.policy(), canMaintain: this.maintenanceDevice(device), devices: this.store.config.devices.filter(d => d.memory).map(d => ({ id: d.id, name: d.id })) };
      case 'configurePolicy': {
        for (const id of [input.primary, input.backup].filter(Boolean)) if (!this.store.config.devices.some(d => d.id === id && d.memory)) throw new ServiceError(400, 'Maintenance device needs memory permission');
        if (input.primary && input.primary === input.backup) throw new ServiceError(400, 'Primary and backup must differ');
        this.store.db.prepare('INSERT INTO memory_policy VALUES (1,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(JSON.stringify(input));
        return this.execute(device, 'policy', {});
      }
      case 'rename': return this.store.transaction(() => {
        if (input.path === input.target) throw new ServiceError(400, 'Choose a different path');
        const source = this.store.memoryFile(device, input.path), target = this.store.memoryFile(device, input.target);
        if (!source || source.content === null || source.version !== input.baseVersion || target?.content != null) throw new ServiceError(409, 'Source changed or target already exists');
        const saved = this.store.writeMemory(device, input.target, target?.version ?? 0, source.content, true);
        this.store.writeMemory(device, input.path, input.baseVersion, null, true); return { file: saved };
      });
      case 'restore': {
        const old = this.store.db.prepare('SELECT content FROM memory_versions WHERE path=? AND version=?').get(input.path, input.version);
        if (!old) throw new ServiceError(404, 'Version not found');
        return { file: this.store.writeMemory(device, input.path, input.baseVersion, old.content as string | null) };
      }
      case 'list': return { files: this.store.memoryFiles(device).map(({ content, ...file }) => ({ ...file, hash: content === null ? null : createHash('sha256').update(content).digest('hex') })) };
      case 'read': return { file: this.store.memoryFile(device, input.path) };
      case 'write': {
        try { return { file: this.store.writeMemory(device, input.path, input.baseVersion, input.content) }; }
        catch (e) { if (!(e instanceof ServiceError) || e.status !== 409) throw e; return { conflict: this.conflict(device, { ...input, local: input.content }) }; }
      }
      case 'conflicts': return { conflicts: this.conflicts() };
      case 'conflict': return { conflict: this.conflict(device, input) };
      case 'claim': return this.store.transaction(() => {
        if (!this.maintenanceDevice(device)) throw new ServiceError(403, 'Not the configured maintenance device');
        const item = this.get(input.id);
        if (item.claimedBy === device.id && item.executionId === input.executionId) return item;
        if (item.status !== 'pending' || item.attempts >= 1) throw new ServiceError(409, 'Conflict already claimed or needs human review');
        return this.save({ ...item, claimedBy: device.id, executionId: input.executionId, status: 'analyzing', attempts: item.attempts + 1 });
      });
      case 'defer': return this.store.transaction(() => {
        const item = this.get(input.id);
        if (item.claimedBy !== device.id || item.executionId !== input.executionId) throw new ServiceError(403, 'Not the conflict owner');
        if (item.status === 'resolved') return item;
        return this.save({ ...item, status: 'needs-human', reason: input.reason });
      });
      case 'resolve': return this.store.transaction(() => {
        if (input.executionId && !this.maintenanceDevice(device)) throw new ServiceError(403, 'Maintenance permission has changed');
        const item = this.get(input.id);
        if (input.executionId && (item.claimedBy !== device.id || item.executionId !== input.executionId)) throw new ServiceError(403, 'Not the conflict owner');
        if (item.status === 'resolved') {
          if (item.resolution === input.content) return item;
          throw new ServiceError(409, 'Conflict already resolved differently');
        }
        if (input.version !== item.remoteVersion || (this.store.memoryFile(device, item.path)?.version ?? 0) !== input.version)
          throw new ServiceError(409, 'Memory changed while merging; preserve the candidate for review');
        const saved = this.store.writeMemory(device, item.path, input.version, input.content, true);
        return this.save({ ...item, status: 'resolved', resolution: saved.content, resolutionVersion: saved.version, reason: input.reason, resolvedBy: device.id });
      });
      case 'versions': {
        const versions = this.store.db.prepare('SELECT version, content, updated_by AS updatedBy, updated_at AS updatedAt FROM memory_versions WHERE path = ? AND version < ? ORDER BY version DESC LIMIT 10').all(input.path, input.before ?? Number.MAX_SAFE_INTEGER);
        return { versions, nextBefore: versions.length === 10 ? versions.at(-1)!.version : null };
      }
    }
  }
}
