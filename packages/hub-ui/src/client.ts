export type HubItem = {
  id: string; type: 'device' | 'project' | 'session' | 'command' | 'note' | 'request'; owner: string; updatedAt: number;
  title?: string; name?: string; online?: boolean; ready?: boolean; state?: string; status?: string; nativeId?: string;
  projectId?: string | null; sessionId?: string; instance?: string; readOnly?: boolean; available?: boolean;
  prompt?: string; result?: string; text?: string; sender?: string; createdAt?: number; stopRequested?: boolean;
  kind?: 'approval' | 'question'; details?: string; answer?: string;
  questions?: { id: string; question: string; options: string[] }[];
  attachments?: { name: string; mime: string; data: string }[];
  artifactIds?: string[]; sourceNoteId?: string; linkedSessions?: string[];
  receivedAt?: number | null; readAt?: number | null;
  summary?: string; published?: boolean; executionAllowed?: boolean;
  autoExecute?: boolean; readiness?: { at: number; checks: { id: string; ok: boolean; message: string }[] }; truncated?: boolean;
};
export type Message = { id: string; role: string; text: string; at: number; seq: number; hasDetails?: boolean };
export type Draft = { kind: 'task' | 'note'; target: string; projectId: string; title: string; text: string; attachments: NonNullable<HubItem['attachments']>; sourceNoteId?: string; artifactIds?: string[] };
type Pending = { id: string; op: string; args: Record<string, unknown>; origin: string; device: string; error?: string };
type Cache = { items: HubItem[]; history: Record<string, Message[]>; historyCursors: Record<string, number>; replies: Record<string, string>; replyFiles: Record<string, NonNullable<HubItem['attachments']>>; syncedAt: number | null; draft: Draft };
type Data = { version: 2; scopes: Record<string, Cache>; outbox: Pending[] };
export type HubState = Cache & { ready: boolean; origin: string; device: string; configured: boolean; busy: boolean; error: string; outbox: Pending[] };
export interface HubTransport {
  status(): Promise<{ configured: boolean; url: string; device: string }>;
  hub(input: { origin: string; op: string; args: Record<string, unknown> }): Promise<any>;
  saveArtifact?(input: { origin: string; id: string; name: string }): Promise<unknown>;
}
export interface HubStorage { get(): Promise<string | null>; set(value: string): Promise<void> }
const blank = (): Cache => ({ items: [], history: {}, historyCursors: {}, replies: {}, replyFiles: {}, syncedAt: null, draft: { kind: 'task', target: 'mac', projectId: '', title: '', text: '', attachments: [] } });

/** Durable outbox and origin-scoped offline cache. No model calls and no credentials. */
export class HubSession {
  transport: HubTransport;
  storage: HubStorage;
  private data: Data = { version: 2, scopes: {}, outbox: [] };
  private listeners = new Set<() => void>();
  private writeQueue: Promise<unknown> = Promise.resolve();
  private polling?: Promise<void>;
  private loading?: Promise<void>;
  private state: HubState = { ...blank(), ready: false, origin: '', device: '', configured: false, busy: false, error: '', outbox: [] };
  private previews = new Map<string, Draft>();
  private replyPreviews = new Map<string, Record<string, string>>();
  private historyPending = new Map<string, Promise<void>>();
  constructor(transport: HubTransport, storage: HubStorage) { this.transport = transport; this.storage = storage; }
  snapshot = () => this.state;
  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  private scope() { return `${this.state.origin}|${this.state.device}`; }
  private emit(patch: Partial<HubState> = {}) {
    const cache = this.data.scopes[this.scope()] ?? blank();
    this.state = { ...this.state, ...patch, ...cache,
      draft: this.previews.get(this.scope()) ?? cache.draft,
      replies: this.replyPreviews.get(this.scope()) ?? cache.replies ?? {},
      replyFiles: cache.replyFiles ?? {},
      historyCursors: cache.historyCursors ?? {},
      outbox: this.data.outbox.filter(p => p.origin === this.state.origin && p.device === this.state.device) };
    this.listeners.forEach(fn => fn());
  }
  private mutate(change: (data: Data) => void) {
    const next = this.writeQueue.then(async () => {
      const data = structuredClone(this.data); change(data);
      const json = JSON.stringify(data);
      if (new TextEncoder().encode(json).length > 32 * 1024 * 1024) throw new Error('离线缓存达到 32 MiB 上限；原数据保留');
      await this.storage.set(json); this.data = data; this.emit();
    });
    this.writeQueue = next.catch(() => {}); return next;
  }
  load() {
    if (this.loading) return this.loading;
    this.loading = (async () => {
      const raw = await this.storage.get();
      if (raw) {
        const value = JSON.parse(raw);
        if (value.version !== 2 || !value.scopes || !Array.isArray(value.outbox)) throw new Error('会话缓存格式损坏；未清除原数据');
        this.data = value;
      }
      const status = await this.transport.status();
      this.state.origin = status.url;
      this.state.device = status.device;
      this.emit({ ready: true, configured: status.configured });
    })().catch(error => { this.loading = undefined; this.emit({ error: error.message }); throw error; });
    return this.loading;
  }
  async draft(patch: Partial<Draft>) {
    await this.load();
    const scope = this.scope();
    const value = { ...this.state.draft, ...patch };
    this.previews.set(scope, value); this.emit();
    await this.mutate(data => { (data.scopes[scope] ??= blank()).draft = value; });
    if (this.previews.get(scope) === value) this.previews.delete(scope);
  }
  async reply(sessionId: string, text: string) {
    await this.load();
    const scope = this.scope(), value = { ...this.state.replies, [sessionId]: text };
    this.replyPreviews.set(scope, value); this.emit();
    await this.mutate(data => { (data.scopes[scope] ??= blank()).replies = value; });
    if (this.replyPreviews.get(scope) === value) this.replyPreviews.delete(scope);
  }
  async replyAttachments(sessionId: string, files: NonNullable<HubItem['attachments']>) {
    await this.load(); const scope = this.scope();
    await this.mutate(data => { const cache = data.scopes[scope] ??= blank(); (cache.replyFiles ??= {})[sessionId] = files; });
  }
  async send(op: 'create' | 'send' | 'note' | 'stop' | 'answer' | 'noteState', args: Record<string, unknown>) {
    await this.load();
    const status = await this.transport.status();
    if (!status.configured) throw new Error('请先在设置登录账号或导入已有配对文件');
    if (status.url !== this.state.origin || status.device !== this.state.device) throw new Error('服务或设备已变化，请先刷新并核对目标');
    const requestId = crypto.randomUUID();
    const input = ['create', 'send', 'note'].includes(op) ? { ...args, requestId,
      ...(Array.isArray(args.attachments) ? { attachments: args.attachments.map(a => ({ ...a, id: crypto.randomUUID() })) } : {}) } : args;
    await this.mutate(data => { data.outbox.push({ id: requestId, op, args: input, origin: status.url, device: status.device }); });
    await this.refresh();
    return requestId;
  }
  refresh() {
    if (this.polling) return this.polling;
    this.polling = this.poll().catch(error => { this.emit({ error: error.message }); })
      .finally(() => { this.polling = undefined; this.emit({ busy: false }); });
    return this.polling;
  }
  private async poll() {
    await this.load(); this.emit({ busy: true });
    const status = await this.transport.status();
    this.state.origin = status.url;
    this.state.device = status.device;
    this.emit({ configured: status.configured });
    if (!status.configured) return;
    const scope = this.scope();
    for (const pending of [...this.data.outbox].filter(p => p.origin === status.url && p.device === status.device)) {
      try {
        const args = await this.prepareAttachments(pending);
        await this.transport.hub({ origin: status.url, op: pending.op, args });
        await this.mutate(data => { data.outbox = data.outbox.filter(p => p.id !== pending.id); });
      } catch (error) {
        await this.mutate(data => { const item = data.outbox.find(p => p.id === pending.id); if (item) item.error = (error as Error).message; });
      }
    }
    const items: HubItem[] = []; let after = 0;
    for (let page = 0; page < 1000; page++) {
      const result = await this.transport.hub({ origin: status.url, op: 'snapshot', args: { after } });
      if (!Array.isArray(result.items)) throw new Error('服务未返回有效会话索引');
      items.push(...result.items);
      if (!result.hasMore) break;
      if (result.nextCursor <= after) throw new Error('无效同步游标');
      after = result.nextCursor;
      if (page === 999) throw new Error('服务索引过大；缓存保留');
    }
    await this.mutate(data => { const cache = data.scopes[scope] ??= blank(); cache.items = items; cache.syncedAt = Date.now(); });
    this.emit({ error: '' });
  }
  private async prepareAttachments(pending: Pending) {
    if (!Array.isArray(pending.args.attachments)) return pending.args;
    const attachments = pending.args.attachments as { id?: string; name: string; mime: string; data: string }[];
    if (pending.op === 'note' && attachments.some(a => !a.id)) return pending.args; // Preserve pre-upgrade request fingerprints.
    if (attachments.some(a => !a.id)) {
      for (const a of attachments) a.id ??= crypto.randomUUID();
      await this.mutate(data => { const row = data.outbox.find(p => p.id === pending.id); if (row) row.args.attachments = attachments; });
    }
    const ids = Array.isArray(pending.args.artifactIds) ? [...pending.args.artifactIds] as string[] : [];
    const target = pending.args.target ?? this.state.items.find(i => i.id === pending.args.sessionId)?.owner;
    if (!target && attachments.length) throw new Error('原会话所属设备不可用；附件与待发内容保留');
    const call = (op: string, args: Record<string, unknown>) => this.transport.hub({ origin: pending.origin, op, args });
    for (const file of attachments) {
      const bytes = Uint8Array.from(atob(file.data), c => c.charCodeAt(0));
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      const sha256 = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
      const artifact = await call('artifactBegin', { id: file.id, target, name: file.name, mime: file.mime, size: bytes.length, sha256 });
      if (artifact.state !== 'ready') {
        for (let start = 0, index = 0; start < bytes.length; start += 192 * 1024, index++) {
          let binary = ''; const end = Math.min(bytes.length, start + 192 * 1024);
          for (let n = start; n < end; n += 8192) binary += String.fromCharCode(...bytes.subarray(n, Math.min(n + 8192, end)));
          await call('artifactChunk', { id: file.id, index, data: btoa(binary) });
        }
        await call('artifactSeal', { id: file.id });
      }
      ids.push(file.id!);
    }
    const { attachments: _, ...rest } = pending.args;
    return { ...rest, artifactIds: [...new Set(ids)] };
  }
  async artifact(id: string) {
    const origin = this.state.origin;
    const meta = await this.transport.hub({ origin, op: 'artifactRead', args: { id } });
    if (meta.size > 8 * 1024 * 1024) throw new Error('附件超过客户端支持大小');
    const bytes = new Uint8Array(meta.size);
    for (let start = 0, index = 0; start < bytes.length; start += 192 * 1024, index++) {
      const value = await this.transport.hub({ origin, op: 'artifactRead', args: { id, index } });
      bytes.set(Uint8Array.from(atob(value.data), c => c.charCodeAt(0)), start);
    }
    const actual = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
    if (actual !== meta.sha256) throw new Error('附件校验失败，未打开不完整文件');
    return { ...meta, bytes };
  }
  artifactMetadata(id: string) { return this.transport.hub({ origin: this.state.origin, op: 'artifactRead', args: { id } }); }
  details(sessionId: string, messageId: string) { return this.transport.hub({ origin: this.state.origin, op: 'details', args: { sessionId, messageId } }); }
  async saveArtifact(id: string, name: string) {
    if (this.transport.saveArtifact) return this.transport.saveArtifact({ origin: this.state.origin, id, name });
    const file = await this.artifact(id), url = URL.createObjectURL(new Blob([file.bytes], { type: 'application/octet-stream' }));
    const link = document.createElement('a'); link.href = url; link.download = file.name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
  history(sessionId: string) {
    const key = this.scope() + '|' + sessionId;
    const pending = this.historyPending.get(key); if (pending) return pending;
    const request = this.fetchHistory(sessionId).finally(() => this.historyPending.delete(key));
    this.historyPending.set(key, request); return request;
  }
  private async fetchHistory(sessionId: string) {
    const origin = this.state.origin;
    const scope = this.scope();
    const messages: Message[] = []; let after = this.state.historyCursors[sessionId] ?? 0;
    for (let page = 0; page < 1000; page++) {
      const result = await this.transport.hub({ origin, op: 'history', args: { sessionId, after } });
      messages.push(...result.messages);
      const next = result.nextCursor ?? after;
      if (result.hasMore && next <= after) throw new Error('历史游标无效');
      if (next > after) after = next;
      if (!result.hasMore) break;
      if (!result.messages.length) throw new Error('历史游标无效');
      if (page === 999) throw new Error('历史规模超过当前缓存限制，旧记录保留');
    }
    if (messages.length) await this.mutate(data => {
      const cache = data.scopes[scope] ??= blank(), merged = new Map((cache.history[sessionId] ?? []).map(m => [m.id, m]));
      for (const message of messages) merged.set(message.id, message);
      cache.history[sessionId] = [...merged.values()]; (cache.historyCursors ??= {})[sessionId] = after;
    });
  }
}
