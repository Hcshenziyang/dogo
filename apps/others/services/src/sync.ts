import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync,
  readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, parse, resolve } from 'node:path';
import { homedir } from 'node:os';
import { z } from 'zod';
import { ApiError, ServiceClient } from './client.ts';
import { memoryPath } from './schema.ts';
import type { MemoryFile } from './schema.ts';

const hash = (value: string | null) => value === null ? null : createHash('sha256').update(value).digest('hex');
const stateSchema = z.object({
  server: z.string(), device: z.string(),
  files: z.record(memoryPath, z.object({ version: z.number().int().nonnegative(), hash: z.string().nullable() }).strict()),
}).strict();
type State = z.infer<typeof stateSchema>;
type Entry = Omit<MemoryFile, 'content'> & { hash: string | null };

function regular(path: string) {
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink > 1) throw new Error(`Refusing non-regular or linked file: ${path}`);
  if (info.size > 1024 * 1024) throw new Error(`File exceeds 1 MiB: ${path}`);
}

export function readText(path: string): string {
  regular(path);
  return new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(path));
}

export function ensureDirectory(path: string) {
  if (!existsSync(path)) mkdirSync(path, { mode: 0o700 });
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Refusing linked/non-directory path: ${path}`);
}

export function destination(root: string, relative: string) {
  memoryPath.parse(relative);
  let current = root;
  const parts = relative.split('/');
  for (const part of parts.slice(0, -1)) {
    current = join(current, part);
    if (existsSync(current)) {
      const info = lstatSync(current);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Unsafe directory: ${current}`);
    }
  }
  return join(root, ...parts);
}

export function atomicWrite(path: string, content: string) {
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, content, { flag: 'wx', mode: 0o600 });
    renameSync(temp, path);
  } finally { if (existsSync(temp)) unlinkSync(temp); }
}

export function scan(root: string): Map<string, string> {
  const files = new Map<string, string>();
  let bytes = 0;
  function walk(directory: string, prefix = '') {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const relative = prefix + entry.name;
      if (entry.isSymbolicLink()) throw new Error(`Symlinks are not synced: ${relative}`);
      if (entry.isDirectory()) {
        // Validate directory segments even before there are any files below them.
        memoryPath.parse(`${relative}/probe.md`);
        walk(join(directory, entry.name), `${relative}/`);
      } else if (entry.isFile() && /\.(md|txt|json)$/i.test(entry.name)) {
        memoryPath.parse(relative);
        const value = readText(join(directory, entry.name));
        if (value.length > 256_000) throw new Error(`Memory file exceeds 256000 characters: ${relative}`);
        bytes += Buffer.byteLength(value);
        files.set(relative, value);
        if (files.size > 1000 || bytes > 32 * 1024 * 1024) throw new Error('Shared folder exceeds 1000 files / 32 MiB');
      }
    }
  }
  walk(root);
  return files;
}

export async function syncFolder(client: ServiceClient, folder: string, reconcile?: (input: { path: string; baseVersion: number; local: string | null; remoteVersion: number }) => Promise<{ content: string | null; version: number } | null>) {
  const selected = resolve(folder);
  if (lstatSync(selected).isSymbolicLink() || !lstatSync(selected).isDirectory()) throw new Error('Select a real dedicated shared-memory directory');
  const root = realpathSync(selected);
  if (root === parse(root).root || root === realpathSync(homedir())) throw new Error('Do not sync a filesystem root or home directory');
  const metadata = join(root, '.dogo-sync');
  ensureDirectory(metadata);
  const lock = join(metadata, 'lock');
  if (existsSync(lock)) {
    // Only reclaim a lock belonging to a process known to have exited; unknown/legacy locks stay protected.
    const before = lstatSync(lock);
    let owner: { pid?: number } = {};
    try { owner = JSON.parse(readText(lock)); } catch { /* Retain an unreadable lock. */ }
    if (Number.isSafeInteger(owner.pid) && owner.pid! > 0) {
      let dead = false;
      try { process.kill(owner.pid!, 0); } catch (error) { dead = (error as NodeJS.ErrnoException).code === 'ESRCH'; }
      if (dead && existsSync(lock) && lstatSync(lock).ino === before.ino) unlinkSync(lock);
    }
  }
  const handle = openSync(lock, 'wx', 0o600);
  writeFileSync(handle, JSON.stringify({ pid: process.pid, at: Date.now() }));
  closeSync(handle);
  try {
    const identity = await client.request<{ device: string }>('/v1/identity');
    const statePath = join(metadata, 'state.json');
    const state: State = existsSync(statePath) ? stateSchema.parse(JSON.parse(readText(statePath)))
      : { server: client.url, device: identity.device, files: {} };
    if (state.server !== client.url || state.device !== identity.device) throw new Error('Folder belongs to a different server/device; do not reuse its sync state');
    const local = scan(root);
    const manifest = await client.request<{ files: Entry[] }>('/v1/memory');
    // A remote response is untrusted input even on an authenticated connection.
    const entries = z.array(z.object({ path: memoryPath, version: z.number().int().positive(),
      hash: z.string().regex(/^[a-f0-9]{64}$/).nullable(), updatedBy: z.string(), updatedAt: z.number() }).strict()).max(1000).parse(manifest.files);
    const remote = new Map(entries.map(file => [file.path, file]));
    if (remote.size !== entries.length) throw new Error('Duplicate remote memory paths');
    const report = { uploaded: [] as string[], downloaded: [] as string[], deleted: [] as string[], conflicts: [] as string[] };
    for (const path of new Set([...local.keys(), ...remote.keys(), ...Object.keys(state.files)])) {
      const base = state.files[path];
      const there = remote.get(path);
      const here = local.get(path) ?? null;
      const localHash = hash(here);
      const remoteHash = there?.hash ?? null;
      const version = there?.version ?? 0;
      // Missing history is not a remote deletion: protect against server rollback/reset.
      if (base && (!there || version < base.version || (version === base.version && remoteHash !== base.hash))) {
        report.conflicts.push(path); continue;
      }
      if (localHash === remoteHash) {
        state.files[path] = { version, hash: localHash };
        atomicWrite(statePath, JSON.stringify(state));
        continue;
      }
      const localChanged = base ? localHash !== base.hash : here !== null;
      const remoteChanged = base ? version !== base.version : there !== undefined;
      if (localChanged && remoteChanged) {
        const merged = await reconcile?.({ path, baseVersion: base?.version ?? 0, local: here, remoteVersion: version });
        if (!merged || merged.version !== version || hash(merged.content) !== remoteHash) { report.conflicts.push(path); continue; }
        const target = destination(root, path);
        if (hash(existsSync(target) ? readText(target) : null) !== localHash) { report.conflicts.push(path); continue; }
        const verified = await client.request<MemoryFile>(`/v1/memory/file?path=${encodeURIComponent(path)}`);
        if (verified.version !== merged.version || verified.content !== merged.content) { report.conflicts.push(path); continue; }
        const backup = join(metadata, 'backups'); ensureDirectory(backup);
        if (here !== null) writeFileSync(join(backup, `${randomUUID()}.json`), JSON.stringify({ path, content: here, at: Date.now() }), { flag: 'wx', mode: 0o600 });
        if (merged.content === null) { if (existsSync(target)) unlinkSync(target); report.deleted.push(path); }
        else { let parent = root; for (const part of path.split('/').slice(0, -1)) { parent = join(parent, part); ensureDirectory(parent); } atomicWrite(target, merged.content); report.downloaded.push(path); }
        state.files[path] = { version, hash: remoteHash }; atomicWrite(statePath, JSON.stringify(state));
        continue;
      }
      if (localChanged) {
        try {
          const saved = await client.request<MemoryFile>('/v1/memory/file', 'PUT', { path, baseVersion: version, content: here });
          state.files[path] = { version: saved.version, hash: localHash };
          (here === null ? report.deleted : report.uploaded).push(path);
        } catch (error) {
          if (!(error instanceof ApiError) || error.status !== 409) throw error;
          report.conflicts.push(path);
          continue;
        }
      } else {
        const file = await client.request<MemoryFile>(`/v1/memory/file?path=${encodeURIComponent(path)}`);
        if (file.version !== version || file.path !== path || hash(file.content) !== remoteHash) { report.conflicts.push(path); continue; }
        const target = destination(root, path);
        // Protect edits made while this pass was waiting on the network.
        const current = existsSync(target) ? readText(target) : null;
        if (hash(current) !== localHash) { report.conflicts.push(path); continue; }
        const backup = join(metadata, 'backups');
        ensureDirectory(backup);
        if (current !== null) writeFileSync(join(backup, `${randomUUID()}.json`),
          JSON.stringify({ path, content: current, at: Date.now() }), { flag: 'wx', mode: 0o600 });
        if (file.content === null) {
          if (current !== null) unlinkSync(target);
          report.deleted.push(path);
        } else {
          let parent = root;
          for (const part of path.split('/').slice(0, -1)) { parent = join(parent, part); ensureDirectory(parent); }
          atomicWrite(target, file.content);
          report.downloaded.push(path);
        }
        state.files[path] = { version, hash: remoteHash };
      }
      atomicWrite(statePath, JSON.stringify(state));
    }
    return report;
  } finally { unlinkSync(lock); }
}
