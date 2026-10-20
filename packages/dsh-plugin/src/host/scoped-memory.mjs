import { createHash } from 'node:crypto';
import { z } from 'zod';

export const scopes = ['personal', 'topic', 'project', 'session'];
const scope = z.enum(scopes);
const scopeId = z.string().trim().min(1).max(160);
const identity = { scope, scopeId: scopeId.optional() };
const checkScope = (value, ctx) => {
  if (value.scope === 'personal' ? value.scopeId !== undefined : !value.scopeId)
    ctx.addIssue({ code: 'custom', message: 'personal must omit scopeId; topic/project/session require an explicit stable scopeId' });
};
const link = z.object({ ...identity, id: z.string().uuid().optional() }).strict().superRefine(checkScope);
const body = {
  text: z.string().trim().min(1).max(32000),
  tags: z.array(z.string().trim().min(1).max(80)).max(30),
  related: z.array(link).max(30),
};
const source = z.object({
  sessionId: z.string().min(1).max(200), seq: z.number().int().nonnegative(),
  callId: z.string().min(1).max(200),
}).strict();
export const recordSchema = z.object({
  format: z.literal('dogo-memory-v1'), ...identity, id: z.string().uuid(), ...body,
  createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
  source, updatedSource: source,
}).strict().superRefine(checkScope);
const common = { ...identity };
const version = z.string().regex(/^[a-f0-9]{64}$/);
export const memoryInput = z.discriminatedUnion('action', [
  z.object({ action: z.literal('create'), ...common, text: body.text, tags: body.tags.optional(), related: body.related.optional() }).strict(),
  z.object({ action: z.literal('read'), ...common, id: z.string().uuid() }).strict(),
  z.object({ action: z.literal('update'), ...common, id: z.string().uuid(), version, text: body.text.optional(), tags: body.tags.optional(), related: body.related.optional() }).strict(),
  z.object({ action: z.literal('delete'), ...common, id: z.string().uuid(), version }).strict(),
  z.object({ action: z.literal('search'), ...common, query: z.string().max(500).default(''), offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(50).default(20) }).strict(),
  z.object({ action: z.literal('contexts'), scope, offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(50).default(20) }).strict(),
  z.object({ action: z.literal('legacy_read'), scope: z.enum(['personal', 'session']), scopeId: scopeId.optional(),
    query: z.string().max(500).default(''), id: z.string().uuid().optional(), path: z.string().min(1).max(240).optional(),
    offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(50).default(20) }).strict(),
  z.object({ action: z.literal('legacy_forget'), scope: z.enum(['personal', 'session']), scopeId: scopeId.optional(),
    id: z.string().uuid().optional(), path: z.string().min(1).max(240).optional(), version }).strict(),
]).superRefine((value, ctx) => {
  if (value.action !== 'contexts') checkScope(value, ctx);
  if (value.action === 'update' && !['text', 'tags', 'related'].some(key => value[key] !== undefined))
    ctx.addIssue({ code: 'custom', message: 'update requires text, tags or related' });
  if (value.action === 'legacy_read' || value.action === 'legacy_forget') {
    if (value.scope === 'personal' && value.id !== undefined || value.scope === 'session' && value.path !== undefined)
      ctx.addIssue({ code: 'custom', message: 'Legacy personal files use path; legacy workspace facts use id' });
    if (value.action === 'legacy_forget' && !(value.scope === 'personal' ? value.path : value.id))
      ctx.addIssue({ code: 'custom', message: 'legacy_forget requires an exact path (personal) or id (session)' });
  }
});
export const memoryVersion = value => createHash('sha256').update(value).digest('hex');
const hash = memoryVersion;
const sameScope = (a, b) => a.scope === b.scope && a.scopeId === b.scopeId;
export const recordPath = value => `records/${value.scope}/${value.scope === 'personal' ? 'self' : hash(value.scopeId)}/${value.id}.json`;
export function parseRecord(file, raw) {
  const value = recordSchema.parse(JSON.parse(raw));
  if (recordPath(value) !== file) throw new Error('Memory identity does not match its file path');
  return value;
}

/** All scopes share the existing file synchronizer; the content hash is a CAS token,
 * including edits made from settings or another device. No second fact database. */
export class ScopedMemory {
  constructor(files) { this.files = files; }
  entries() {
    const records = [], errors = [];
    for (const file of this.files.list().filter(file => file.startsWith('records/'))) {
      try { const raw = this.files.read(file); records.push({ ...parseRecord(file, raw), version: hash(raw), path: file }); }
      catch { errors.push({ path: file, error: 'Invalid memory record; inspect or restore it in settings' }); }
    }
    return { records, errors };
  }
  execute(input, origin) {
    const args = memoryInput.parse(input);
    if (args.action.startsWith('legacy_')) throw new Error('Legacy operations require the compatibility bridge');
    if (args.action === 'contexts' || args.action === 'search') {
      const { records, errors } = this.entries();
      const selected = records.filter(record => args.action === 'contexts' ? record.scope === args.scope : sameScope(record, args));
      if (args.action === 'contexts') {
        const ids = [...new Set(selected.map(record => record.scopeId ?? null))].sort();
        return { contexts: ids.slice(args.offset, args.offset + args.limit).map(id => ({ scope: args.scope, ...(id ? { scopeId: id } : {}) })), total: ids.length, errors };
      }
      const terms = args.query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
      const matches = selected.filter(record => terms.every(term => `${record.text} ${record.tags.join(' ')}`.toLocaleLowerCase().includes(term)))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
      return { records: matches.slice(args.offset, args.offset + args.limit), total: matches.length, errors };
    }
    const caller = args.action === 'read' ? undefined : source.parse(origin);
    // A retry of the same DSH call targets the same record, even after a restart.
    const digest = args.action === 'create' ? hash(JSON.stringify([caller.sessionId, caller.callId])) : '';
    const id = args.id ?? `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
    const selected = { scope: args.scope, ...(args.scopeId ? { scopeId: args.scopeId } : {}), id };
    const file = recordPath(selected), raw = this.files.read(file);
    const existing = raw === null ? null : parseRecord(file, raw);
    if (args.action === 'read') {
      if (!existing) throw new Error('Memory not found in the specified scope');
      return { record: existing, version: hash(raw), path: file };
    }
    if (args.action === 'create' && existing) {
      if (existing.text !== args.text || JSON.stringify(existing.tags) !== JSON.stringify(args.tags ?? []) || JSON.stringify(existing.related) !== JSON.stringify(args.related ?? []))
        throw new Error('This call already created a different record; read it before updating');
      return { record: existing, version: hash(raw), path: file, saved: true, replayed: true };
    }
    if (args.action !== 'create' && (!existing || hash(raw) !== args.version))
      throw new Error('Memory changed or was deleted; read the current record before retrying');
    if (args.action === 'delete') {
      this.files.write(file, null, raw);
      return { ...selected, deleted: true, historyRetained: true };
    }
    const now = new Date().toISOString();
    const record = recordSchema.parse({
      ...(existing ?? { format: 'dogo-memory-v1', ...selected, createdAt: now, source: caller, tags: [], related: [] }),
      ...Object.fromEntries(['text', 'tags', 'related'].filter(key => args[key] !== undefined).map(key => [key, args[key]])),
      updatedAt: now, updatedSource: caller,
    });
    const content = JSON.stringify(record, null, 2);
    this.files.write(file, content, raw);
    return { record, version: hash(content), path: file, saved: true };
  }
}
