import { randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { receiveArtifacts } from './artifacts.mjs';

export class HubClient {
  constructor(engine) {
    this.engine = engine;
    this.instance = engine.store.value('instance', randomUUID());
    engine.store.setValue('instance', this.instance);
    this.projects = engine.store.value('projects', []).map(p => ({ published: true, executionAllowed: true, ...p }));
    this.nativeIds = engine.store.value('native-session-ids', {});
    this.policy = engine.store.value('remote-policy', { autoExecute: false });
    this.state = { items: [], connected: false, error: '', syncedAt: null };
  }
  snapshot() { return { ...this.state, projects: this.projects, policy: this.policy, instance: this.instance }; }
  scope() { return `hub:${this.engine.relay.key.url}|${this.engine.relay.key.device}`; }
  call(op, args = {}) { return this.engine.relay.request('/v2/hub', { op, args }); }
  async configure(input) {
    this.policy = z.object({ autoExecute: z.boolean() }).strict().parse(input);
    this.engine.store.setValue('remote-policy', this.policy);
    if (!this.policy.autoExecute && this.engine.relay.key) {
      const jobs = this.engine.store.value(this.scope() + ':jobs', {});
      for (const [id, job] of Object.entries(jobs)) if (!job.returned && ['accepted', 'admitting'].includes(job.phase))
        await this.engine.dsh.request('/stop-command', { id }).catch(() => {});
    }
    this.engine.changed();
    return this.snapshot();
  }
  async register(folder) {
    const root = await realpath(folder);
    if (!(await stat(root)).isDirectory()) throw new Error('请选择项目文件夹');
    let project = this.projects.find(p => p.path === root);
    if (!project) {
      project = { id: randomUUID(), path: root, name: path.basename(root), summary: '', available: true, published: true, executionAllowed: true };
      this.projects.push(project);
      this.engine.store.setValue('projects', this.projects);
    }
    this.engine.changed();
    return project;
  }
  async updateProject(input) {
    const value = z.object({ id: z.string().uuid(), name: z.string().trim().min(1).max(200), summary: z.string().max(1000), published: z.boolean(), executionAllowed: z.boolean() }).strict().parse(input);
    const project = this.projects.find(p => p.id === value.id);
    if (!project) throw new Error('项目未登记，未猜测目录位置');
    Object.assign(project, value);
    if (!value.published || !value.executionAllowed) for (const job of this.engine.capabilities?.active.values() ?? []) if (job.projectId === value.id) job.controller.abort();
    project.available = value.published && value.executionAllowed && await stat(project.path).then(s => s.isDirectory(), () => false);
    this.engine.store.setValue('projects', this.projects); this.engine.changed();
    await this.engine.relay.refresh(); return this.snapshot();
  }
  async all() {
    const items = []; let after = 0;
    for (let page = 0; page < 1000; page++) {
      const result = await this.call('snapshot', { after });
      items.push(...result.items);
      if (!result.hasMore) return items;
      if (result.nextCursor <= after) throw new Error('无效同步游标');
      after = result.nextCursor;
    }
    throw new Error('同步规模超过当前支持范围，未清除缓存');
  }
  async refresh() {
    if (this.closed || this.engine.closing) return;
    this.state.error = '';
    try { await this.poll(); }
    catch (error) { this.state.connected = false; this.state.error = String(error.message ?? error).slice(0, 1000); }
    this.engine.changed();
  }
  async poll() {
    const { engine } = this;
    const settings = engine.store.settings();
    const device = engine.relay.key.device;
    if (this.currentScope !== this.scope()) {
      this.currentScope = this.scope();
      this.state = { ...engine.store.value(this.scope() + ':snapshot', { items: [], syncedAt: null }), connected: false, error: '' };
    }
    for (const p of this.projects) p.available = p.published && p.executionAllowed && await stat(p.path).then(s => s.isDirectory(), () => false);
    let ready = false;
    if (settings.model) { await engine.dsh.ensure(settings); ready = true; }
    await this.call('advertise', { instance: this.instance, name: process.platform === 'darwin' ? '我的 Mac' : '我的电脑', ready,
      readiness: this.engine.readiness ?? { at: 0, checks: [{ id: 'prepare', ok: false, message: '尚未在 Mac 设置中运行准备检查' }] }, autoExecute: this.policy.autoExecute,
      projects: this.projects.map(({ path: _, ...p }) => p) });
    let items = await this.all();
    const notes = engine.store.value(this.scope() + ':notes', {});
    for (const note of items.filter(i => i.type === 'note' && i.owner === device)) {
      let files;
      try { files = notes[note.id]?.localFiles ?? await receiveArtifacts(engine.directory, note.artifactIds, (op, args) => this.call(op, args)); }
      catch (error) { this.state.error = `资料附件尚未收齐：${String(error.message ?? error).slice(0, 500)}`; continue; }
      note.localFiles = files;
      notes[note.id] = note;
      engine.store.setValue(this.scope() + ':notes', notes); // Receipt only after local durable storage.
      if (!note.receivedAt) await this.call('noteState', { id: note.id, state: 'received' });
    }
    if (ready) {
      await engine.dsh.request('/remote-policy', { enabled: true });
      const catalog = await engine.dsh.request('/sessions');
      for (const local of catalog.sessions) {
        try {
        let remote = items.find(i => i.type === 'session' && i.owner === device && i.nativeId === local.nativeId && i.instance === this.instance);
        const project = this.projects.find(p => p.path === local.cwd);
        if (!remote && !this.nativeIds[local.nativeId]) {
          this.nativeIds[local.nativeId] = randomUUID();
          engine.store.setValue('native-session-ids', this.nativeIds);
        }
        remote = await this.call('session', { id: remote?.id ?? this.nativeIds[local.nativeId], nativeId: local.nativeId, instance: this.instance,
          title: local.title.slice(0, 300), projectId: project?.id ?? remote?.projectId ?? null,
          state: local.state, readOnly: local.readOnly, cursor: local.cursor });
        const key = this.scope() + ':history-with-tools:' + remote.id;
        const cursor = engine.store.value(key, -1);
        if (local.cursor > cursor) {
          const history = await engine.dsh.request(`/history?id=${local.nativeId}&after=${cursor}`);
          for (let offset = 0; offset < history.messages.length; offset += 8)
            await this.call('append', { sessionId: remote.id, messages: history.messages.slice(offset, offset + 8) });
          engine.store.setValue(key, history.cursor);
        }
        } catch (error) {
          // One damaged/deleted history must not prevent unrelated tasks from progressing.
          this.state.error = `部分会话同步失败，旧缓存保留：${String(error.message ?? error).slice(0, 500)}`;
        }
      }
      items = await this.all();
      const jobsKey = this.scope() + ':jobs';
      const jobs = engine.store.value(jobsKey, {});
      const persist = () => engine.store.setValue(jobsKey, jobs);
      for (const command of items.filter(i => i.type === 'command' && i.owner === device && i.status === 'running')) {
        if (command.createdBy === 'native') {
          if (command.stopRequested) await engine.dsh.request('/stop-command', { id: command.id });
          continue;
        }
        const job = jobs[command.id];
        if (!job || job.executionId !== command.executionId) continue; // Unknown ownership is never reclaimed.
        if (job.phase === 'prepared') {
          if (command.stopRequested) { await this.call('finish', { id: command.id, executionId: job.executionId, status: 'cancelled', result: '开始执行前已停止或撤销授权，未执行' }); job.returned = true; persist(); }
          continue; // Claim may have succeeded before its response was lost; admission is still safe.
        }
        let run;
        try { run = await engine.dsh.request(`/command?id=${command.id}`); }
        catch (error) {
          if (error.status !== 404) throw error;
          // No durable admission receipt after a restart: outcome unknown, do not replay.
          run = { status: 'interrupted', output: '', error: '执行接收状态无法确认，未自动重跑。请查看原会话。' };
        }
        if (command.stopRequested && run.status === 'running') await engine.dsh.request('/stop-command', { id: command.id });
        if (run.status !== 'running') {
          await this.call('finish', { id: command.id, executionId: job.executionId, status: run.status,
            result: [run.output, run.error, run.truncated ? '单轮结果较长；完整正文见原会话历史。' : ''].filter(Boolean).join('\n\n').slice(-512000) });
          job.returned = true; persist();
        }
      }
      const requests = await engine.dsh.request('/requests');
      for (const request of requests.requests) {
        const session = items.find(i => i.type === 'session' && i.owner === device && i.nativeId === request.sessionId);
        if (!session) continue;
        const remote = await this.call('request', { ...request, sessionId: session.id });
        if (remote.answer && request.state === 'pending') {
          await engine.dsh.request('/answer', { id: request.id, answer: remote.answer });
          await this.call('request', { ...request, sessionId: session.id, state: 'closed' });
        }
      }
      for (const request of items.filter(i => i.type === 'request' && i.owner === device && i.state === 'pending')) {
        if (!requests.requests.some(r => r.id === request.id)) await this.call('request', {
          id: request.id, sessionId: request.sessionId, kind: request.kind,
          title: request.title, details: request.details, questions: request.questions, state: 'closed',
        });
      }
      if (this.policy.autoExecute && !this.closed && !engine.closing) {
        const busy = new Set(catalog.sessions.filter(s => s.state !== 'idle').map(s => s.nativeId));
        for (const command of items.filter(i => i.type === 'command' && i.owner === device &&
          (i.status === 'queued' || (i.status === 'running' && jobs[i.id]?.phase === 'prepared')))) {
          const session = items.find(i => i.type === 'session' && i.id === command.sessionId);
          if (!session || session.instance !== this.instance || busy.has(session.nativeId)) continue;
          if (jobs[command.id] && jobs[command.id].phase !== 'prepared') continue;
          const project = session.projectId && this.projects.find(p => p.id === session.projectId && p.available);
          const job = jobs[command.id] ??= { executionId: randomUUID(), phase: 'prepared' }; persist();
          const claim = await this.call('claim', { id: command.id, executionId: job.executionId });
          if (claim.status !== 'running') continue;
          if (claim.stopRequested) { await this.call('finish', { id: command.id, executionId: job.executionId, status: 'cancelled', result: '开始执行前已停止或撤销授权，未执行' }); job.returned = true; persist(); continue; }
          try {
            if (session.projectId && !project) throw new Error('原项目目录不可用，不会换目录执行');
            if (session.readOnly) throw new Error('旧只读测试会话保持原权限；请新建正常 DSH 会话');
            const exists = catalog.sessions.some(s => s.nativeId === session.nativeId);
            if (!exists && session.createdBy !== 'dogo') throw new Error('原 DSH 会话已不可用，不会新建替代会话');
            const attachments = await receiveArtifacts(engine.directory, command.artifactIds, (op, args) => this.call(op, args));
            job.phase = 'admitting'; persist();
            await engine.dsh.request('/command', { requestId: command.id, sessionId: session.nativeId,
              prompt: command.prompt, create: !exists, ...(attachments.length ? { attachments } : {}), ...(project ? { cwd: project.path } : {}) });
            job.phase = 'accepted'; persist(); busy.add(session.nativeId);
          } catch (error) {
            // Admission may have happened. The next poll queries the same request, never resubmits it.
            job.error = String(error.message ?? error); persist();
            if (job.phase === 'prepared') await this.call('finish', { id: command.id, executionId: job.executionId, status: 'failed', result: job.error });
          }
        }
      }
    }
    items = await this.all();
    this.state = { ...this.state, items, connected: true, syncedAt: Date.now() };
    engine.store.setValue(this.scope() + ':snapshot', this.state);
    await this.pulse();
  }
  async pulse() {
    if (this.pulsing || this.closed || this.engine.closing || !this.engine.relay.key || this.engine.dsh.state !== 'ready') return;
    this.pulsing = true;
    let done; this.pulseDone = new Promise(resolve => { done = resolve; });
    try {
      const scope = this.scope(), cursorKey = scope + ':run-cursor';
      let after = this.engine.store.value(cursorKey, 0);
      const jobs = this.engine.store.value(scope + ':jobs', {});
      for (let page = 0; page < 100; page++) {
        if (this.closed || this.engine.closing) break;
        const batch = await this.engine.dsh.request(`/runs?after=${after}`);
        let blocked = false;
        for (const run of batch.runs) {
          const session = this.state.items.find(i => i.type === 'session' && i.nativeId === run.sessionId && i.instance === this.instance && i.owner === this.engine.relay.key.device);
          if (!session) { blocked = true; break; } // Discover the original session before advancing past its run.
          const result = [run.output, run.error].filter(Boolean).join('\n\n').slice(-512000);
          if (run.origin === 'native') await this.call('observe', { id: run.requestId, sessionId: session.id, prompt: run.prompt,
            result, status: run.status, truncated: !!run.truncated, revision: run.revision, createdAt: run.createdAt });
          else if (jobs[run.requestId]?.executionId) await this.call('progress', { id: run.requestId, executionId: jobs[run.requestId].executionId,
            result, truncated: !!run.truncated, revision: run.revision });
          after = run.revision; this.engine.store.setValue(cursorKey, after);
        }
        if (blocked || !batch.hasMore) break;
      }
    } catch (error) { this.state.error = `实时回传等待重试：${String(error.message ?? error).slice(0, 300)}`; }
    finally { this.pulsing = false; done(); }
  }
  async action(input) {
    const value = z.object({ op: z.enum(['snapshot', 'history', 'details', 'noteState', 'create', 'send', 'note', 'stop', 'answer', 'artifactBegin', 'artifactChunk', 'artifactSeal', 'artifactRead']), args: z.record(z.string(), z.unknown()) }).strict().parse(input);
    const result = await this.call(value.op, value.args);
    if (!['history', 'details', 'snapshot'].includes(value.op) && !value.op.startsWith('artifact')) await this.engine.relay.refresh();
    return result;
  }
  async close() { this.closed = true; if (this.engine.dsh.state === 'ready') await this.engine.dsh.request('/remote-policy', { enabled: false }).catch(() => {}); if (this.engine.relay.key) await this.call('offline').catch(() => {}); }
  async suspend() {
    this.closed = true;
    if (!this.engine.relay.key) return;
    const jobs = this.engine.store.value(this.scope() + ':jobs', {});
    for (const [id, job] of Object.entries(jobs)) {
      if (!job.returned && ['accepted', 'admitting'].includes(job.phase))
        await this.engine.dsh.request('/stop-command', { id }).catch(() => {});
    }
  }
}
