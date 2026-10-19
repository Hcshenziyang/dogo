import { createHash } from 'node:crypto';
import { z } from 'zod';
import { id, ServiceError } from './schema.ts';
import type { Device } from './schema.ts';
import type { Store } from './store.ts';

export const CHUNK_SIZE = 192 * 1024;
export const attachmentName = z.string().min(1).max(200).refine(v => !/[\x00-\x1f/\\]/.test(v) && !['.', '..'].includes(v));
export const artifactIds = z.array(z.string().uuid()).max(4).default([]);
export const artifactSchemas = {
  artifactBegin: z.object({ id: z.string().uuid(), target: id, name: attachmentName, mime: z.string().min(1).max(100),
    size: z.number().int().min(0).max(8 * 1024 * 1024), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  artifactChunk: z.object({ id: z.string().uuid(), index: z.number().int().min(0).max(42),
    data: z.string().max(CHUNK_SIZE * 4 / 3).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/) }).strict(),
  artifactSeal: z.object({ id: z.string().uuid() }).strict(),
  artifactRead: z.object({ id: z.string().uuid(), index: z.number().int().min(0).max(42).optional() }).strict(),
};
type Artifact = { id: string; owner: string; uploader: string; name: string; mime: string; size: number; sha256: string; state: string; createdAt: number };

/** Immutable binary content, stored separately from conversation envelopes; uploads are resumable. */
export class Artifacts {
  store: Store;
  allowed: (device: Device, owner: string) => boolean;
  constructor(store: Store, allowed: (device: Device, owner: string) => boolean) {
    this.store = store; this.allowed = allowed;
    store.db.exec(`CREATE TABLE IF NOT EXISTS hub_artifacts (id TEXT PRIMARY KEY, owner TEXT NOT NULL, uploader TEXT NOT NULL,
      name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL, state TEXT NOT NULL, createdAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS hub_artifact_chunks (artifact TEXT NOT NULL, idx INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY(artifact,idx));`);
  }
  get(id: string) {
    const item = this.store.db.prepare('SELECT * FROM hub_artifacts WHERE id=?').get(id) as Artifact | undefined;
    if (!item) throw new ServiceError(404, 'Attachment missing'); return item;
  }
  bind(device: Device, target: string, ids: string[]) {
    let total = 0;
    for (const id of ids) {
      const a = this.get(id); total += a.size;
      if (a.owner !== target || !this.allowed(device, a.owner)) throw new ServiceError(403, 'Attachment belongs to another device');
      if (a.state !== 'ready') throw new ServiceError(409, 'Attachment is incomplete; execution has not started');
    }
    if (total > 8 * 1024 * 1024) throw new ServiceError(413, 'Attachments total exceeds 8 MiB');
  }
  execute(device: Device, op: string, value: unknown): any {
    if (!Object.hasOwn(artifactSchemas, op)) throw new ServiceError(404, 'Unknown attachment operation');
    const input = artifactSchemas[op as keyof typeof artifactSchemas].parse(value) as any;
    if (op === 'artifactBegin') {
      if (!this.store.config.devices.some(d => d.id === input.target) || !this.allowed(device, input.target)) throw new ServiceError(403, 'Attachment target not authorized');
      const old = this.store.db.prepare('SELECT * FROM hub_artifacts WHERE id=?').get(input.id) as Artifact | undefined;
      if (old) {
        if (old.uploader !== device.id || old.owner !== input.target || ['name', 'mime', 'size', 'sha256'].some(k => (old as any)[k] !== input[k])) throw new ServiceError(409, 'Attachment ID already used');
        return old;
      }
      const usage = this.store.db.prepare('SELECT SUM(size) AS bytes, COUNT(*) AS count FROM hub_artifacts WHERE uploader=?').get(device.id)!;
      if (Number(usage.bytes) + input.size > 1024 ** 3 || Number(usage.count) >= 10000) throw new ServiceError(413, 'Device attachment storage limit reached (1 GiB or 10000 files)');
      this.store.db.prepare('INSERT INTO hub_artifacts VALUES(?,?,?,?,?,?,?,?,?)').run(input.id, input.target, device.id, input.name, input.mime, input.size, input.sha256, 'uploading', this.store.now());
      return this.get(input.id);
    }
    const item = this.get(input.id);
    if (!this.allowed(device, item.owner)) throw new ServiceError(403, 'Attachment access revoked');
    if (op === 'artifactRead') {
      if (item.state !== 'ready') throw new ServiceError(409, 'Attachment is incomplete');
      if (input.index === undefined) return item;
      const row = this.store.db.prepare('SELECT data FROM hub_artifact_chunks WHERE artifact=? AND idx=?').get(item.id, input.index);
      if (!row) throw new ServiceError(404, 'Attachment chunk missing');
      return { data: Buffer.from(row.data as Uint8Array).toString('base64') };
    }
    if (device.id !== item.uploader) throw new ServiceError(403, 'Only uploader may complete attachment');
    if (op === 'artifactChunk') {
      const data = Buffer.from(input.data, 'base64');
      const expected = Math.min(CHUNK_SIZE, item.size - input.index * CHUNK_SIZE);
      if (expected <= 0 || data.length !== expected) throw new ServiceError(400, 'Invalid attachment chunk size');
      const old = this.store.db.prepare('SELECT data FROM hub_artifact_chunks WHERE artifact=? AND idx=?').get(item.id, input.index);
      if (old && !Buffer.from(old.data as Uint8Array).equals(data)) throw new ServiceError(409, 'Attachment chunk is immutable');
      if (!old) {
        if (item.state === 'ready') throw new ServiceError(409, 'Completed attachment is immutable');
        this.store.db.prepare('INSERT INTO hub_artifact_chunks VALUES(?,?,?)').run(item.id, input.index, data);
      }
      return { ok: true };
    }
    return this.store.transaction(() => {
      const chunks = this.store.db.prepare('SELECT idx,data FROM hub_artifact_chunks WHERE artifact=? ORDER BY idx').all(item.id);
      if (chunks.length !== Math.ceil(item.size / CHUNK_SIZE) || chunks.some((r, n) => r.idx !== n)) throw new ServiceError(409, 'Attachment upload incomplete');
      const data = Buffer.concat(chunks.map(r => Buffer.from(r.data as Uint8Array)));
      if (data.length !== item.size || createHash('sha256').update(data).digest('hex') !== item.sha256) throw new ServiceError(409, 'Attachment checksum mismatch');
      this.store.db.prepare("UPDATE hub_artifacts SET state='ready' WHERE id=?").run(item.id);
      return this.get(item.id);
    });
  }
}
