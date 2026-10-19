import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { id, ServiceError } from './schema.ts';
import type { Device } from './schema.ts';
import type { Store } from './store.ts';
import { Artifacts, artifactSchemas, artifactIds } from './artifacts.ts';

const uuid = z.string().uuid();
const nativeId = z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
const text = z.string().max(64000);
export const projectSchema = z.object({ id: uuid, name: z.string().min(1).max(200), available: z.boolean(), summary: z.string().max(1000).default(''),
  published: z.boolean().default(true), executionAllowed: z.boolean().default(true) }).strict();
const sessionSchema = z.object({ id: uuid, nativeId, instance: uuid, title: z.string().max(300), projectId: uuid.nullable(),
  state: z.enum(['idle', 'running', 'waiting', 'unavailable']), readOnly: z.boolean().default(false), cursor: z.number().int().min(-1) }).strict();
const messageSchema = z.object({ id: z.string().max(160), role: z.enum(['user', 'assistant', 'system', 'tool']), text, at: z.number(), seq: z.number().int(),
  detail: z.string().max(64000).optional(), detailTruncated: z.boolean().optional() }).strict();
const attachmentSchema = z.object({ name: z.string().min(1).max(200).refine(v => !/[\x00-\x1f/\\]/.test(v)),
  mime: z.string().max(100), data: z.string().max(350000).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/) }).strict();
export const hubSchemas = {
  ...artifactSchemas,
  snapshot: z.object({ after: z.number().int().nonnegative().default(0) }).strict(),
  get: z.object({ id: uuid, type: z.enum(['session', 'command', 'note', 'request']) }).strict(),
  advertise: z.object({ instance: uuid, name: z.string().max(100), ready: z.boolean(), projects: z.array(projectSchema).max(500), autoExecute: z.boolean().optional(),
    readiness: z.object({ at: z.number(), checks: z.array(z.object({ id: z.string().max(100), ok: z.boolean(), message: z.string().max(1000) }).strict()).max(30) }).strict().optional() }).strict(),
  session: sessionSchema,
  history: z.object({ sessionId: uuid, after: z.number().int().nonnegative().default(0) }).strict(),
  details: z.object({ sessionId: uuid, messageId: z.string().max(160) }).strict(),
  append: z.object({ sessionId: uuid, messages: z.array(messageSchema).max(50) }).strict(),
  create: z.object({ requestId: uuid, target: id, projectId: uuid.nullable().default(null), title: z.string().min(1).max(300), prompt: text.min(1), artifactIds, sourceNoteId: uuid.optional() }).strict(),
  send: z.object({ requestId: uuid, sessionId: uuid, prompt: text.min(1), artifactIds }).strict(),
  claim: z.object({ id: uuid, executionId: uuid }).strict(),
  finish: z.object({ id: uuid, executionId: uuid, status: z.enum(['succeeded', 'failed', 'cancelled', 'interrupted']), result: z.string().max(512000) }).strict(),
  progress: z.object({ id: uuid, executionId: uuid, result: z.string().max(512000), truncated: z.boolean(), revision: z.number().int().nonnegative() }).strict(),
  observe: z.object({ id: uuid, sessionId: uuid, prompt: text, result: z.string().max(512000), status: z.enum(['running', 'succeeded', 'failed', 'cancelled', 'interrupted']),
    truncated: z.boolean(), revision: z.number().int().nonnegative(), createdAt: z.number() }).strict(),
  stop: z.object({ id: uuid }).strict(),
  note: z.object({ requestId: uuid, target: id, projectId: uuid.nullable().default(null), title: z.string().min(1).max(300), text,
    attachments: z.array(attachmentSchema).max(2).default([]), artifactIds }).strict(),
  noteState: z.object({ id: uuid, state: z.enum(['received', 'read', 'processed', 'archived']) }).strict(),
  request: z.object({ id: uuid, sessionId: uuid, kind: z.enum(['approval', 'question']), title: z.string().max(2000),
    details: z.string().max(32000), state: z.enum(['pending', 'closed']), questions: z.array(z.object({ id: z.string(), question: z.string(), options: z.array(z.string()).default([]) })).max(10).default([]) }).strict(),
  answer: z.object({ id: uuid, answer: z.string().min(1).max(16000) }).strict(),
  offline: z.object({}).strict(),
} as const;

type Entity = Record<string, any> & { id: string; owner: string; updatedAt: number };
/** One personal deployment is one trust domain. Device routing still requires publishTo authorization. */
export class Hub {
  store: Store;
  artifacts: Artifacts;
  constructor(store: Store) {
    this.store = store;
    this.artifacts = new Artifacts(store, (device, owner) => this.allowed(device, owner));
    store.db.exec(`CREATE TABLE IF NOT EXISTS hub (id TEXT PRIMARY KEY, kind TEXT NOT NULL, owner TEXT NOT NULL, body TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS hub_kind ON hub(kind);
      CREATE TABLE IF NOT EXISTS hub_messages (seq INTEGER PRIMARY KEY AUTOINCREMENT, session TEXT NOT NULL, message_id TEXT NOT NULL, body TEXT NOT NULL, UNIQUE(session,message_id));
      CREATE INDEX IF NOT EXISTS hub_history ON hub_messages(session,seq);
      CREATE TABLE IF NOT EXISTS hub_requests (sender TEXT NOT NULL, request_id TEXT NOT NULL, fingerprint TEXT NOT NULL, result TEXT NOT NULL, PRIMARY KEY(sender,request_id));`);
  }
  allowed(device: Device, owner: string) { return device.id === owner || device.publishTo.some(p => this.store.config.mailboxes[p] === owner); }
  requireTarget(device: Device, owner: string) {
    if (!this.store.config.devices.some(d => d.id === owner) || !this.allowed(device, owner)) throw new ServiceError(403, 'Device route not authorized');
  }
  all(kind: string): Entity[] { return this.store.db.prepare('SELECT body FROM hub WHERE kind = ? ORDER BY rowid').all(kind).map(r => JSON.parse(r.body as string)); }
  get(kind: string, entityId: string): Entity {
    const row = this.store.db.prepare('SELECT body FROM hub WHERE kind = ? AND id = ?').get(kind, entityId);
    if (!row) throw new ServiceError(404, 'Item not found');
    return JSON.parse(row.body as string);
  }
  visible(device: Device, kind: string, entityId: string) {
    const item = this.get(kind, entityId);
    if (item.sender !== device.id && !this.allowed(device, item.owner)) throw new ServiceError(404, 'Item not found');
    return item;
  }
  owned(device: Device, kind: string, entityId: string) {
    const item = this.get(kind, entityId);
    if (item.owner !== device.id) throw new ServiceError(403, 'Only the owning device can update this item');
    return item;
  }
  put(kind: string, item: Entity) {
    const old = this.store.db.prepare('SELECT kind, owner, body FROM hub WHERE id = ?').get(item.id);
    if (old && (old.kind !== kind || old.owner !== item.owner)) throw new ServiceError(409, 'Stable identity cannot change owner or kind');
    const { updatedAt: _oldTime, ...oldBody } = old ? JSON.parse(old.body as string) : {};
    const { updatedAt: _time, ...newBody } = item;
    if (old && JSON.stringify(oldBody) === JSON.stringify(newBody)) return JSON.parse(old.body as string);
    item.updatedAt = this.store.now();
    this.store.db.prepare('INSERT INTO hub VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(item.id, kind, item.owner, JSON.stringify(item));
    this.store.event(this.store.config.devices.filter(d => d.id === item.sender || this.allowed(d, item.owner)).map(d => d.id), `hub.${kind}`, item.id);
    return item;
  }
  once(device: Device, requestId: string, input: unknown, fn: () => Entity) {
    return this.store.transaction(() => {
      const normalized = { ...(input as Record<string, unknown>) };
      if (Array.isArray(normalized.artifactIds) && !normalized.artifactIds.length) delete normalized.artifactIds;
      const fingerprint = JSON.stringify(normalized);
      const old = this.store.db.prepare('SELECT fingerprint, result FROM hub_requests WHERE sender = ? AND request_id = ?').get(device.id, requestId);
      if (old) {
        if (old.fingerprint !== fingerprint) throw new ServiceError(409, 'requestId already used for different content');
        return JSON.parse(old.result as string);
      }
      const result = fn();
      this.store.db.prepare('INSERT INTO hub_requests VALUES (?, ?, ?, ?)').run(device.id, requestId, fingerprint, JSON.stringify(result));
      return result;
    });
  }
  checkProject(owner: string, projectId: string | null) {
    if (!projectId) return;
    const project = this.get('project', projectId);
    if (project.owner !== owner || !project.available || project.published === false || project.executionAllowed === false) throw new ServiceError(409, 'Project unavailable or execution permission revoked on the original device');
  }
  command(device: Device, session: Entity, requestId: string, prompt: string, attachments: string[] = []) {
    this.requireTarget(device, session.owner);
    this.checkProject(session.owner, session.projectId);
    this.artifacts.bind(device, session.owner, attachments);
    return this.put('command', { id: requestId, owner: session.owner, sender: device.id, sessionId: session.id, prompt,
      artifactIds: attachments, executionId: null, status: 'queued', stopRequested: false, result: '', createdAt: this.store.now(), updatedAt: 0 });
  }
  reconcileAuthorization() {
    for (const command of this.all('command')) {
      if (command.createdBy === 'native' || !['queued', 'running'].includes(command.status)) continue;
      const sender = this.store.config.devices.find(d => d.id === command.sender);
      let valid = !!sender && this.allowed(sender, command.owner) && this.store.config.devices.some(d => d.id === command.owner);
      try { this.checkProject(command.owner, this.get('session', command.sessionId).projectId); } catch { valid = false; }
      if (!valid && !command.stopRequested) this.put('command', { ...command, stopRequested: true,
        status: command.status === 'queued' ? 'cancelled' : command.status,
        authorizationError: '设备、路由或项目授权已撤销；执行端收到后停止，不自动重跑',
        ...(command.status === 'queued' ? { result: '执行前授权已撤销，未执行' } : {}) });
    }
  }
  execute(device: Device, op: string, value: unknown): any {
    if (Object.hasOwn(artifactSchemas, op)) return this.artifacts.execute(device, op, value);
    if (!Object.hasOwn(hubSchemas, op)) throw new ServiceError(404, 'Unknown operation');
    const input = hubSchemas[op as keyof typeof hubSchemas].parse(value) as any;
    switch (op) {
      case 'get': return this.visible(device, input.type, input.id);
      case 'snapshot': {
        this.reconcileAuthorization();
        const rows = this.store.db.prepare('SELECT rowid AS cursor, kind, body FROM hub WHERE rowid > ? ORDER BY rowid LIMIT 20').all(input.after);
        const items = rows.map(r => ({ ...JSON.parse(r.body as string), type: r.kind })).filter(i => i.sender === device.id || this.allowed(device, i.owner))
          .map(i => i.type === 'device' ? { ...i, online: this.store.online(i.owner) }
            : i.type === 'project' && i.published === false ? { ...i, name: '已撤销公开的项目', summary: '' } : i);
        return { items, nextCursor: rows.at(-1)?.cursor ?? input.after, hasMore: rows.length === 20, at: this.store.now() };
      }
      case 'advertise': return this.store.transaction(() => {
        const oldDevice = this.all('device').find(d => d.owner === device.id);
        if (oldDevice && oldDevice.instance !== input.instance) throw new ServiceError(409, 'Instance changed; explicit re-pairing is required');
        this.put('device', { ...input, projects: undefined, id: oldDevice?.id ?? randomUUID(), owner: device.id, updatedAt: 0 });
        for (const project of this.all('project').filter(project => project.owner === device.id && !input.projects.some((p: any) => p.id === project.id))) {
          this.put('project', { ...project, available: false, published: false });
        }
        for (const project of input.projects) this.put('project', { ...project, owner: device.id, updatedAt: 0 });
        return { ok: true };
      });
      case 'session': {
        const host = this.all('device').find(d => d.owner === device.id && d.instance === input.instance);
        if (!host) throw new ServiceError(409, 'Advertise the connected instance first');
        const existing = this.all('session').find(s => s.id === input.id || (s.owner === device.id && s.instance === input.instance && s.nativeId === input.nativeId));
        if (existing && (existing.id !== input.id || existing.owner !== device.id || existing.instance !== input.instance || existing.nativeId !== input.nativeId))
          throw new ServiceError(409, 'Session identity cannot migrate');
        return this.put('session', { ...existing, ...input, owner: device.id, updatedAt: 0 });
      }
      case 'history': {
        this.visible(device, 'session', input.sessionId);
        const rows = this.store.db.prepare('SELECT seq, body FROM hub_messages WHERE session = ? AND seq > ? ORDER BY seq LIMIT 30').all(input.sessionId, input.after);
        return { messages: rows.map(r => { const { detail, ...message } = JSON.parse(r.body as string); return { ...message, ...(detail !== undefined ? { hasDetails: true } : {}) }; }), nextCursor: rows.at(-1)?.seq ?? input.after, hasMore: rows.length === 30 };
      }
      case 'details': {
        this.visible(device, 'session', input.sessionId);
        const row = this.store.db.prepare('SELECT body FROM hub_messages WHERE session=? AND message_id=?').get(input.sessionId, input.messageId);
        if (!row) throw new ServiceError(404, 'Tool history missing');
        const message = JSON.parse(row.body as string);
        return { detail: message.detail ?? message.text, truncated: !!message.detailTruncated };
      }
      case 'append': {
        this.owned(device, 'session', input.sessionId);
        return this.store.transaction(() => {
          for (const message of input.messages) {
            const old = this.store.db.prepare('SELECT body FROM hub_messages WHERE session = ? AND message_id = ?').get(input.sessionId, message.id);
            if (old && old.body !== JSON.stringify(message)) throw new ServiceError(409, 'History records are immutable');
            this.store.db.prepare('INSERT OR IGNORE INTO hub_messages(session,message_id,body) VALUES (?,?,?)').run(input.sessionId, message.id, JSON.stringify(message));
          }
          return { ok: true };
        });
      }
      case 'create': return this.once(device, input.requestId, { op, ...input }, () => {
        this.requireTarget(device, input.target);
        this.checkProject(input.target, input.projectId);
        const host = this.all('device').find(d => d.owner === input.target);
        if (!host) throw new ServiceError(409, 'Device has not registered its DSH instance');
        const source = input.sourceNoteId ? this.visible(device, 'note', input.sourceNoteId) : undefined;
        if (source && source.owner !== input.target) throw new ServiceError(409, 'Source note belongs to another device');
        if (source?.attachments?.length && input.artifactIds.length < source.attachments.length) throw new ServiceError(409, 'Upload legacy note attachments before conversion');
        const files = [...new Set<string>([...input.artifactIds, ...(source?.artifactIds ?? [])])];
        if (files.length > 4) throw new ServiceError(400, 'At most four attachments');
        const session = this.put('session', { id: randomUUID(), nativeId: randomUUID(), instance: host.instance, owner: input.target,
          title: input.title, projectId: input.projectId, state: 'idle', readOnly: false, cursor: -1, createdBy: 'dogo', sourceNoteId: input.sourceNoteId, updatedAt: 0 });
        const result = this.command(device, session, input.requestId, input.prompt, files);
        if (source) this.put('note', { ...source, linkedSessions: [...(source.linkedSessions ?? []), session.id] });
        return result;
      });
      case 'send': return this.once(device, input.requestId, { op, ...input }, () => this.command(device, this.visible(device, 'session', input.sessionId), input.requestId, input.prompt, input.artifactIds));
      case 'claim': return this.store.transaction(() => {
        this.reconcileAuthorization();
        const command = this.owned(device, 'command', input.id);
        const sender = this.store.config.devices.find(d => d.id === command.sender);
        if (['queued', 'running'].includes(command.status) && (!sender || !this.allowed(sender, command.owner))) return this.put('command', { ...command,
          status: command.status === 'queued' ? 'cancelled' : command.status, stopRequested: true, authorizationError: '发送设备或执行路由授权已撤销' });
        if (command.stopRequested) return command;
        if (command.executionId === input.executionId) return command;
        if (command.status !== 'queued') throw new ServiceError(409, 'Command already claimed; do not repeat execution');
        return this.put('command', { ...command, status: 'running', executionId: input.executionId });
      });
      case 'progress': {
        const command = this.owned(device, 'command', input.id);
        if (command.executionId !== input.executionId) throw new ServiceError(409, 'Execution mismatch');
        if (command.status !== 'running' || (command.revision ?? -1) >= input.revision) return command;
        return this.put('command', { ...command, result: input.result, truncated: input.truncated, revision: input.revision });
      }
      case 'observe': {
        const session = this.owned(device, 'session', input.sessionId);
        const old = this.all('command').find(c => c.id === input.id);
        if (old && (old.createdBy !== 'native' || old.sessionId !== session.id || old.owner !== device.id)) throw new ServiceError(409, 'Native run identity mismatch');
        if (old && (old.revision ?? -1) >= input.revision) return old;
        return this.put('command', { ...old, ...input, owner: device.id, sender: device.id, executionId: input.id, createdBy: 'native', stopRequested: old?.stopRequested ?? false, updatedAt: 0 });
      }
      case 'finish': return this.store.transaction(() => {
        const command = this.owned(device, 'command', input.id);
        if (command.executionId !== input.executionId) throw new ServiceError(409, 'Execution mismatch');
        if (command.status === input.status && command.result === input.result) return command;
        if (command.status !== 'running') throw new ServiceError(409, 'Command is already terminal');
        return this.put('command', { ...command, status: input.status, result: input.result });
      });
      case 'stop': return this.store.transaction(() => {
        const command = this.visible(device, 'command', input.id);
        this.requireTarget(device, command.owner);
        if (command.status === 'queued') return this.put('command', { ...command, status: 'cancelled', result: '执行前已撤回', stopRequested: true });
        return this.put('command', { ...command, stopRequested: true });
      });
      case 'note': return this.once(device, input.requestId, { op, ...input }, () => {
        this.requireTarget(device, input.target);
        this.checkProject(input.target, input.projectId);
        this.artifacts.bind(device, input.target, input.artifactIds);
        return this.put('note', { ...input, id: input.requestId, owner: input.target, sender: device.id, state: 'saved', receivedAt: null, readAt: null, processedAt: null, archivedAt: null, createdAt: this.store.now(), updatedAt: 0 });
      });
      case 'noteState': {
        const note = input.state === 'received' ? this.owned(device, 'note', input.id) : this.visible(device, 'note', input.id);
        this.requireTarget(device, note.owner);
        const order = ['saved', 'received', 'read', 'processed', 'archived'];
        return this.put('note', { ...note, [input.state + 'At']: note[input.state + 'At'] ?? this.store.now(),
          state: order.indexOf(input.state) > order.indexOf(note.state) ? input.state : note.state });
      }
      case 'request': {
        const session = this.owned(device, 'session', input.sessionId);
        const old = this.all('request').find(r => r.id === input.id);
        if (old && old.sessionId !== session.id) throw new ServiceError(409, 'Request session mismatch');
        return this.put('request', { ...old, ...input, owner: device.id, updatedAt: 0 });
      }
      case 'answer': return this.store.transaction(() => {
        const request = this.visible(device, 'request', input.id);
        this.requireTarget(device, request.owner);
        if (request.state !== 'pending') throw new ServiceError(409, 'Request expired');
        if (request.answer && request.answer !== input.answer) throw new ServiceError(409, 'Already answered');
        return this.put('request', { ...request, answer: input.answer, answeredBy: device.id });
      });
      case 'offline': this.store.db.prepare('DELETE FROM presence WHERE device = ?').run(device.id); return { ok: true };
    }
  }
}
