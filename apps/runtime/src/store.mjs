import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";

export class Store {
  constructor(directory) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path.join(directory, "desktop.sqlite"));
    this.db.exec(
      "PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS config (id INTEGER PRIMARY KEY, data TEXT NOT NULL)",
    );
    this.db.exec('CREATE TABLE IF NOT EXISTS relay_jobs (id TEXT PRIMARY KEY, data TEXT NOT NULL)');
    this.db.exec('CREATE TABLE IF NOT EXISTS local_state (id TEXT PRIMARY KEY, data TEXT NOT NULL)');
    for (const task of this.tasks()) {
      if (task.status === "running" || task.status === "queued")
        this.save({
          ...task,
          status: "interrupted",
          error: "上次运行意外结束。为避免重复执行，未自动重跑。",
          updatedAt: new Date().toISOString(),
        });
    }
  }
  tasks() {
    return this.db
      .prepare("SELECT data FROM tasks")
      .all()
      .map((row) => JSON.parse(row.data))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  get(id) {
    const row = this.db.prepare("SELECT data FROM tasks WHERE id = ?").get(id);
    if (!row) throw new Error("任务不存在");
    return JSON.parse(row.data);
  }
  save(task) {
    this.db
      .prepare(
        "INSERT INTO tasks VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      )
      .run(task.id, JSON.stringify(task));
  }
  settings() {
    const row = this.db.prepare("SELECT data FROM config WHERE id = 1").get();
    return row
      ? JSON.parse(row.data)
      : {
          endpoint: "http://127.0.0.1:8000/v1",
          model: "",
          contextWindow: 32768,
          maxTokens: 4096,
          relayUrl: "",
        };
  }
  configure(value) {
    this.db
      .prepare(
        "INSERT INTO config VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      )
      .run(JSON.stringify(value));
  }
  close() {
    this.db.close();
  }
  relayJobs() {
    return this.db.prepare('SELECT data FROM relay_jobs').all().map(row => JSON.parse(row.data));
  }
  saveRelayJob(job) {
    this.db.prepare('INSERT INTO relay_jobs VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data=excluded.data')
      .run(job.key, JSON.stringify(job));
  }
  value(id, fallback) {
    const row = this.db.prepare('SELECT data FROM local_state WHERE id = ?').get(id);
    return row ? JSON.parse(row.data) : fallback;
  }
  setValue(id, value) {
    this.db.prepare('INSERT INTO local_state VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(id, JSON.stringify(value));
  }
}
