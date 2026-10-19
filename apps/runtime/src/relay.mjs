import { randomUUID } from 'node:crypto';
import { z } from 'zod';

export const serviceOrigin = z.string().url().refine(value => {
    const u = new URL(value);
    return u.protocol === 'https:' && !u.username && !u.password && !u.search && !u.hash && u.pathname === '/';
  }, '设备凭据必须绑定一个 HTTPS 服务地址');
export const pairingSchema = z.discriminatedUnion('version', [z.object({
  version: z.literal(1), url: serviceOrigin,
  device: z.enum(['mac', 'win']),
  token: z.string().regex(/^[A-Za-z0-9_-]{43,128}$/),
}).strict(), z.object({
  version: z.literal(2), url: serviceOrigin, device: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
  platform: z.enum(['mac', 'win']), token: z.string().regex(/^[A-Za-z0-9_-]{43,128}$/),
}).strict()]);
const remoteTask = z.object({
  id: z.string().uuid(), title: z.string().max(300), instructions: z.string().max(64000),
  sender: z.string().max(100), executor: z.string().max(100),
  status: z.enum(['queued', 'running', 'succeeded', 'failed']),
  executionId: z.string().nullable(), result: z.string().max(128000).nullable(),
});

/** Fetches tasks, never executes them until the local user accepts one. */
export class Relay {
  constructor(engine, fetcher = fetch) {
    this.engine = engine;
    this.fetcher = fetcher;
    this.state = { configured: false, connected: false, url: '', device: '', error: '', inbox: [] };
  }
  snapshot() {
    return structuredClone({ ...this.state, deliveries: this.engine.store.relayJobs().map(job => ({
      localId: job.localId, returned: job.returned, error: job.error || '',
    })) });
  }
  async request(path, body) {
    const key = this.key;
    if (!key) throw new Error('尚未导入设备凭据');
    const res = await this.fetcher(key.url + path, {
      method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
      headers: { Authorization: `Bearer ${key.token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw Object.assign(new Error(`中转服务 HTTP ${res.status}；${res.status === 401 ? '登录已失效，请重新登录' : '任务未自动重跑'}`), { status: res.status });
    const reader = res.body.getReader();
    const chunks = []; let size = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 24 * 1024 * 1024) throw new Error('服务响应过大');
        chunks.push(Buffer.from(value));
      }
    } finally { await reader.cancel(); }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }
  async connect(input) {
    if (this.accepting || this.engine.active.size) throw new Error('任务结束后才能切换设备连接');
    await this.close();
    this.closed = false;
    this.engine.hub.closed = false;
    this.key = pairingSchema.parse(input);
    this.key.url = new URL(this.key.url).origin;
    this.state = { configured: true, connected: false, url: this.key.url, device: this.key.device, error: '', inbox: [] };
    await this.refresh();
    this.timer = setInterval(() => void this.refresh(), 5000);
    this.timer.unref?.();
    this.streamTimer = setInterval(() => { if (!this.pending && this.state.connected) void this.engine.hub.pulse(); }, 750);
    this.streamTimer.unref?.();
    return this.snapshot();
  }
  refresh() {
    if (this.pending) return this.pending;
    if (!this.key || this.closed) return Promise.resolve();
    this.pending = this.poll().catch(error => {
      this.state.connected = false;
      this.state.error = String(error.message ?? '连接失败').slice(0, 200);
      if (error.status === 401) {
        this.closed = true; clearInterval(this.timer); clearInterval(this.streamTimer);
        void this.engine.hub.suspend().catch(() => {});
        this.engine.memory.controller?.abort();
      }
    }).finally(() => {
      this.pending = undefined;
      if (!this.closed) this.engine.changed();
    });
    return this.pending;
  }
  async poll() {
    const identity = await this.request('/v1/identity');
    if (identity.device !== this.key.device || !identity.services?.includes('tasks'))
      throw new Error('凭据身份或服务类型不匹配');
    await this.request('/v1/heartbeat', {});
    let failedReturns = 0;
    for (const job of this.jobs()) {
      if (job.returned) continue;
      const task = this.engine.store.tasks().find(t => t.id === job.localId);
      if (!task) continue; // Claim may have been committed: only a user retry may start it.
      try {
        if (task.status === 'running' || task.status === 'queued') {
          await this.request(`/v1/tasks/${job.remoteId}/progress`, { executionId: job.executionId, message: '本机 Agent 正在执行' });
          if (job.error) this.engine.store.saveRelayJob({ ...job, error: '' });
        } else {
          let result = [task.output, task.error].filter(Boolean).join('\n\n') || '任务结束，无输出';
          if (result.length > 128000) result = result.slice(0, 127900) + '\n[回传长度达到上限；完整结果保留在执行端]';
          await this.request(`/v1/tasks/${job.remoteId}/finish`, { executionId: job.executionId,
            status: task.status === 'succeeded' ? 'succeeded' : 'failed', result });
          this.engine.store.saveRelayJob({ ...job, returned: true, error: '' });
        }
      } catch {
        // A stale/failed result must not prevent other jobs or the inbox from progressing.
        failedReturns++;
        this.engine.store.saveRelayJob({ ...job, error: '回传未确认；保留本机记录并继续重试，不会重跑任务。' });
      }
    }
    const inbox = []; let after = 0;
    for (let page = 0; page < 100; page++) {
      const value = await this.request(`/v1/tasks?after=${after}`);
      const tasks = z.array(remoteTask).max(100).parse(value.tasks);
      for (const task of tasks) {
        if (task.executor !== this.key.device) continue;
        const job = this.jobs().find(j => j.remoteId === task.id);
        const local = job && this.engine.store.tasks().find(t => t.id === job.localId);
        if (!local && (task.status === 'queued' || (task.status === 'running' && task.executionId === job?.executionId)))
          inbox.push(task);
      }
      if (tasks.length < 100) break;
      if (!Number.isSafeInteger(value.nextCursor) || value.nextCursor <= after) throw new Error('无效的服务游标');
      after = value.nextCursor;
    }
    this.state = { ...this.state, connected: true, error: failedReturns ? `${failedReturns} 个任务的进度或结果尚未确认回传，正在重试。` : '', inbox };
    if (identity.protocol >= 2) await this.engine.hub.refresh();
    if (identity.protocol >= 2 && identity.services.includes('memory')) void this.engine.memory.sync();
  }
  jobs() { return this.engine.store.relayJobs().filter(j => j.url === this.key?.url && j.device === this.key?.device); }
  async accept(input) {
    if (this.accepting || this.closed || !this.key) throw new Error('连接未就绪或正在领取任务');
    const args = z.object({ id: z.string().uuid(), kind: z.enum(['inspect', 'analysis']), workspaceId: z.string().optional() }).strict().parse(input);
    this.accepting = true;
    try {
      const remote = remoteTask.parse(await this.request(`/v1/tasks/${args.id}`));
      if (remote.executor !== this.key.device) throw new Error('任务不属于此设备');
      const create = { kind: args.kind, prompt: remote.instructions, workspaceId: args.workspaceId };
      this.engine.validateCreate(create);
      let job = this.jobs().find(j => j.remoteId === remote.id);
      if (job && this.engine.store.tasks().some(t => t.id === job.localId))
        throw new Error('此任务已有本地执行记录，不会重复启动');
      if (remote.status !== 'queued' && !(remote.status === 'running' && remote.executionId === job?.executionId))
        throw new Error('任务已被领取或结束，不会重复启动');
      job ??= { key: `${this.key.url}|${this.key.device}|${remote.id}`, url: this.key.url, device: this.key.device,
        remoteId: remote.id, executionId: randomUUID(), localId: randomUUID(), returned: false };
      this.engine.store.saveRelayJob(job); // Durable execution identity before any network claim.
      const claimed = remoteTask.parse(await this.request(`/v1/tasks/${remote.id}/claim`, { executionId: job.executionId }));
      if (claimed.status !== 'running' || claimed.executionId !== job.executionId) throw new Error('远端任务状态已变化');
      const id = this.engine.create(create, { id: job.localId, source: `${remote.sender} · 远端任务`, remoteId: remote.id });
      this.state.inbox = this.state.inbox.filter(t => t.id !== remote.id);
      this.engine.changed();
      return id;
    } finally { this.accepting = false; }
  }
  async close() {
    this.closed = true;
    clearInterval(this.timer);
    clearInterval(this.streamTimer);
    if (this.pending) await this.pending;
    await this.engine.hub.pulseDone;
  }
  async disconnect() {
    this.engine.hub.closed = true;
    await this.close();
    await this.engine.hub.suspend();
    await this.engine.memory.close();
    await this.engine.hub.close();
    this.key = undefined;
    this.state = { configured: false, connected: false, url: '', device: '', error: '', inbox: [] };
    this.engine.hub.state = { items: [], connected: false, error: '', syncedAt: null };
    this.engine.changed();
  }
}
