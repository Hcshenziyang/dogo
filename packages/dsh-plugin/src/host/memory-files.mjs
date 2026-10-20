import { existsSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { scan, ensureDirectory, destination, readText, atomicWrite } from '@dogo/sync-client/sync';
import { parseRecord } from './scoped-memory.mjs';

// Only the dedicated personal folder is reachable. Compare-and-swap protects concurrent Agent edits.
export class MemoryFiles {
  constructor(root) { this.root = root; }
  prepare() { ensureDirectory(this.root); }
  list() { this.prepare(); return [...scan(this.root).keys()]; }
  read(name) { this.prepare(); const file = destination(this.root, name); return existsSync(file) ? readText(file) : null; }
  write(name, content, base) {
    z.string().max(256000).nullable().parse(content);
    if (name.startsWith('records/') && content !== null) parseRecord(name, content);
    const before = this.read(name);
    if (before !== base) throw new Error('记忆已被其他操作修改；原编辑保留，请重新读取后合并');
    const target = destination(this.root, name);
    if (before === content) return;
    if (before !== null) {
      const metadata = path.join(this.root, '.dogo-sync'); ensureDirectory(metadata);
      const backups = path.join(metadata, 'backups'); ensureDirectory(backups);
      writeFileSync(path.join(backups, randomUUID() + '.json'), JSON.stringify({ path: name, content: before, at: Date.now() }), { flag: 'wx', mode: 0o600 });
    }
    if (content === null) { if (existsSync(target)) unlinkSync(target); return; }
    let parent = this.root;
    for (const part of name.split('/').slice(0, -1)) { parent = path.join(parent, part); ensureDirectory(parent); }
    atomicWrite(target, content);
  }
  rename(name, target, base) {
    if (name === target || this.read(target) !== null || this.read(name) !== base || base === null) throw new Error('记忆源已变化或目标文件已存在');
    this.write(target, base, null); // A crash can leave both names, never lose the only copy.
    this.write(name, null, base);
  }
  export() { return { format: 'dogo-personal-memory-v1', exportedAt: new Date().toISOString(), files: Object.fromEntries(this.list().map(name => [name, this.read(name)])) }; }
}
