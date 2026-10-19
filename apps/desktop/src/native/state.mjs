import { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { capabilityPolicy } from '@dogo/contracts/host';

/** Native authorization is owned by Electron, never writable through the plugin's HTTP API. */
export class NativeState {
  constructor(directory) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.file = path.join(directory, 'native-authorizations.json');
    if (existsSync(this.file)) this.data = JSON.parse(readFileSync(this.file, 'utf8'));
    else {
      this.data = { capabilities: { computer: false, codex: false, sshHosts: [] }, projects: [] };
      const file = path.join(directory, 'desktop.sqlite');
      if (existsSync(file)) {
        const db = new DatabaseSync(file, { readOnly: true });
        try {
          if (db.prepare("SELECT name FROM sqlite_master WHERE name='local_state'").get()) {
            for (const key of ['capabilities', 'projects']) {
              const row = db.prepare('SELECT data FROM local_state WHERE id=?').get(key);
              if (row) this.data[key] = JSON.parse(row.data);
            }
          }
        } finally { db.close(); }
      }
      this.save();
    }
    this.data.capabilities = capabilityPolicy.parse(this.data.capabilities);
    if (!Array.isArray(this.data.projects)) throw new Error('本机项目权限文件损坏');
    this.data.projects = this.data.projects.map(p => ({ published: true, executionAllowed: true, ...p }));
  }
  value(key, fallback) { return this.data[key] ?? fallback; }
  setValue(key, value) { this.data[key] = value; this.save(); }
  save() { writeFileSync(this.file + '.tmp', JSON.stringify(this.data), { mode: 0o600 }); renameSync(this.file + '.tmp', this.file); }
}
