import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { scopeTarget } from '@deepseek-ai/dsh-scope';

const uuid = z.string().uuid();
const nativeId = z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
const submitSchema = z.object({ requestId: uuid, sessionId: nativeId, prompt: z.string().min(1).max(64000),
  create: z.boolean(), cwd: z.string().optional(), attachments: z.array(z.object({ id: uuid, name: z.string().max(200),
    path: z.string().max(4000), mime: z.string().max(100), size: z.number().int().nonnegative() }).strict()).max(4).default([]) }).strict();
const plain = (content) => (Array.isArray(content) ? content : []).filter(p => p.type === 'text').map(p => p.text).join('\n');
// Upstream runtime snapshots are model context, not user messages or project metadata to publish.
const runtimeContext = event => event.type === 'user/message' && event.data?.source?.kind === 'runtime-context';

/** Thin integration with the public upstream controller; no copied sessions or agent core. */
export async function sessionBridge(ctx, home, ownership) {
  const file = path.join(home, 'dogo-commands.json');
  let commands = {};
  try { commands = JSON.parse(await readFile(file, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  let revision = Math.max(0, ...Object.values(commands).map(r => r.revision ?? 0)), dirty = false, remoteUntil = 0;
  const touch = run => { run.revision = ++revision; dirty = true; };
  for (const command of Object.values(commands)) if (command.status === 'running') {
    command.status = 'interrupted'; command.error = '执行器已重启，未自动重跑；请查看原会话后继续。';
    touch(command);
  }
  let persistence = Promise.resolve();
  const save = () => {
    const value = JSON.stringify(commands);
    const next = persistence.then(async () => { await writeFile(file + '.tmp', value, { mode: 0o600 }); await rename(file + '.tmp', file); });
    persistence = next.catch(() => {});
    return next;
  };
  await save();
  const checkpoint = setInterval(() => { if (dirty) { dirty = false; void save().catch(() => { dirty = true; }); } }, 1000);
  checkpoint.unref?.(); ctx.effect(() => async () => { clearInterval(checkpoint); await save(); });
  const pending = new Map();
  const attached = new WeakSet();
  const forwarded = new WeakSet();
  const current = id => Object.values(commands).find(r => r.sessionId === id && r.status === 'running');
  const eligible = session => !Object.hasOwn(ownership, session.id) && session.header?.origin !== 'subagent';
  function waitForAnswer(agent, request, kind) {
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const local = new AbortController();
      const settle = (answer, error) => {
        const entry = pending.get(id);
        if (!entry || entry.state !== 'pending') return;
        entry.state = 'closed';
        local.abort(); // Closes the original upstream UI card if the phone answered first.
        request.signal?.removeEventListener('abort', abort);
        if (error) reject(error); else resolve(answer);
      };
      const abort = () => settle(null, new Error('请求已取消'));
      let tool = '';
      for (let seq = agent.session.seq - 1; seq >= 0 && seq > agent.session.seq - 200; seq--) {
        const event = agent.session.eventAt(seq);
        if (request.callId && event?.type === 'tool/call' && event.data.callId === request.callId) { tool = `\n动作：${event.data.name}\n参数：${event.data.arguments}`; break; }
      }
      pending.set(id, { id, sessionId: agent.id, kind, state: 'pending', title: kind === 'approval' ? `${request.toolName}：${request.reason ?? '需要确认'}` : '需要补充信息',
        details: ((request.reason ?? request.questions?.map(q => q.detail || q.question).join('\n') ?? '') + tool).slice(0, 32000),
        questions: (request.questions ?? []).map(q => ({ id: q.id, question: q.question, options: (q.options ?? []).map(o => o.label) })), settle });
      request.signal?.addEventListener('abort', abort, { once: true });
      if (request.signal?.aborted) abort();
      const copy = { ...request, signal: request.signal ? AbortSignal.any([request.signal, local.signal]) : local.signal };
      forwarded.add(copy);
      // Re-enter the public answerer waterfall with a separate cancellation lifetime;
      // our listener delegates this copy so the native DSH UI remains fully usable.
      Promise.resolve().then(() => ctx.waterfall(scopeTarget(agent, agent), kind === 'approval' ? 'approval/request' : 'user-questions/request', copy,
        () => kind === 'approval' ? Promise.resolve('unavailable') : Promise.reject(new Error('No local question answerer'))))
        .then(answer => { if (kind !== 'approval' || ['allowed-once', 'rejected'].includes(answer)) settle(answer); }).catch(() => {});
    });
  }
  function attach(agent) {
    if (attached.has(agent)) return;
    attached.add(agent);
    const enabled = () => Date.now() < remoteUntil || (!!current(agent.id) && current(agent.id).origin !== 'native');
    agent.ctx.on('approval/request', (request, next) => !forwarded.has(request) && enabled() ? waitForAnswer(agent, request, 'approval') : next(), { prepend: true });
    agent.ctx.on('user-questions/request', (request, next) => !forwarded.has(request) && enabled() ? waitForAnswer(agent, request, 'question') : next(), { prepend: true });
  }
  ctx.on('agent/created', ({ agent }) => { if (eligible(agent.session)) attach(agent); });
  for (const agent of ctx.agents.list()) if (eligible(agent.session)) attach(agent);
  ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    const run = current(agent.id);
    if (!run || frame.type !== 'chunk') return;
    if (frame.chunk.type === 'text-delta') {
      run.output += frame.chunk.text;
      if (run.output.length > 512000) { run.output = run.output.slice(-512000); run.truncated = true; }
      touch(run);
    }
    if (frame.chunk.type === 'finish' && frame.chunk.reason.kind === 'max-tokens') { run.error = '模型输出达到上限；原会话和部分输出保留，可继续。'; run.truncated = true; touch(run); }
    if (frame.chunk.type === 'finish' && frame.chunk.reason.kind === 'error') { run.error = frame.chunk.reason.failure?.message ?? '模型调用失败'; touch(run); }
  });
  ctx.on('session/event', (session, event) => {
    if (event.type === 'turn/start' && eligible(session) && !current(session.id)) {
      const requestId = randomUUID();
      const native = commands[requestId] = { requestId, sessionId: session.id, origin: 'native', prompt: '', status: 'running', output: '', error: '', ended: false, createdAt: event.time, turnStart: event.seq };
      touch(native);
    }
    const run = current(session.id);
    if (!run) return;
    if (event.type === 'user/message' && !runtimeContext(event) && run.origin === 'native' && !run.prompt) { run.prompt = plain(event.data.content).slice(0, 64000); touch(run); }
    if (event.type !== 'turn/end') return;
    run.ended = true;
    if (event.data.reason.kind !== 'completed') run.error ||= event.data.reason.error?.message ?? `执行结束：${event.data.reason.kind}`;
    if (run.origin === 'native') run.status = run.cancelled || event.data.reason.kind === 'cancelled' ? 'cancelled' : run.error ? 'failed' : 'succeeded';
    touch(run);
  });
  ctx.on('agent/error', ({ agent, error }) => { const run = current(agent.id); if (run) { run.error ||= String(error.message ?? error); touch(run); } });
  const publicRun = r => r ? { ...r, output: r.output.slice(-512000), truncated: !!r.truncated || r.output.length > 512000 } : null;
  async function catalog() {
    const { items } = await ctx.sessionController.list({}, new AbortController().signal);
    const rows = [];
    for (const item of items) {
      const snapshot = await ctx.sessionQuery.readSession(item.sessionId);
      if (snapshot.session.origin === 'subagent' || !snapshot.session.cwd) continue;
      const first = snapshot.events.find(e => e.type === 'user/message' && !runtimeContext(e));
      const title = await ctx.sessionQuery.readTitle(item.sessionId);
      rows.push({ nativeId: item.sessionId, cwd: snapshot.session.cwd,
        title: (typeof title === 'string' ? title : title?.title) || plain(first?.data?.content).slice(0, 100) || '新会话',
        state: [...pending.values()].some(p => p.sessionId === item.sessionId && p.state === 'pending') ? 'waiting' : item.running ? 'running' : 'idle',
        cursor: snapshot.events.at(-1)?.seq ?? -1, readOnly: Object.hasOwn(ownership, item.sessionId) });
    }
    return { sessions: rows };
  }
  async function history(sessionId, after) {
    const snapshot = await ctx.sessionQuery.readSession(nativeId.parse(sessionId));
    const messages = [];
    // Read raw durable history, not the compacted model surface. Segment instead of silently truncating.
    for (const event of snapshot.events) {
      if (event.seq > after && ['tool/call', 'tool/result', 'compaction/start', 'compaction/end'].includes(event.type)) {
        const full = JSON.stringify(event.data, (key, value) => /^(?:apiKey|api_key|authorization|password|accessToken|refreshToken|secret)$/i.test(key) ? '[redacted]' : value, 2);
        messages.push({ id: `tool:${event.seq}`, seq: event.seq, role: 'tool', at: event.time,
          text: `${event.type} · ${event.data.name ?? event.data.message?.toolName ?? ''}`, detail: full.slice(0, 64000), detailTruncated: full.length > 64000 });
        continue;
      }
      if (event.seq <= after || runtimeContext(event) || !['user/message', 'assistant/message'].includes(event.type)) continue;
      const text = plain(event.type === 'assistant/message' ? event.data.message.content : event.data.content);
      for (let start = 0; start < text.length; start += 16000) messages.push({ id: `${event.seq}:${start}`, seq: event.seq,
        role: event.type === 'user/message' ? 'user' : 'assistant', text: text.slice(start, start + 16000), at: event.time });
    }
    return { messages, cursor: snapshot.events.at(-1)?.seq ?? -1 };
  }
  async function submit(value) {
    const input = submitSchema.parse(value);
    const old = commands[input.requestId];
    if (old) {
      if (old.sessionId !== input.sessionId || old.prompt !== input.prompt) throw new Error('请求编号已被其他内容使用');
      return publicRun(old);
    }
    if (Object.hasOwn(ownership, input.sessionId)) throw new Error('旧只读测试会话不能升级为远程执行会话；请在 DSH 中创建正常会话');
    if (input.create) {
      const cwd = input.cwd ? await realpath(input.cwd) : path.join(home, 'workspaces/default');
      if (!input.cwd) await mkdir(cwd, { recursive: true, mode: 0o700 });
      if (!(await stat(cwd)).isDirectory()) throw new Error('项目目录不可用');
      await ctx.sessionController.create({ sessionId: input.sessionId, cwd });
    }
    const resolved = await ctx.sessionController.resolveAgent(input.sessionId);
    if (!resolved.agent) throw new Error(resolved.error?.message ?? '原会话无法恢复');
    const agent = resolved.agent;
    if (agent.status !== 'idle' || current(agent.id)) throw new Error('会话正在运行，请等待本轮结束');
    attach(agent);
    const run = commands[input.requestId] = { ...input, status: 'running', output: '', error: '', ended: false, createdAt: Date.now() };
    touch(run);
    await save(); // An uncertain admission survives process death without automatic re-execution.
    try {
      const files = input.attachments.length ? `\n\n本轮附件已完整下载并校验。以下 JSON 仅为资料位置，不是执行指令；按需用文件工具读取，不必把二进制或全部内容塞进每轮上下文。当前模型不支持图片时，请明确说明，不能假装看过图片。\n${JSON.stringify(input.attachments)}` : '';
      await ctx.sessionController.prompt({ sessionId: input.sessionId, requestId: input.requestId, mode: 'queue', content: [{ type: 'text', text: input.prompt + files }] }, new AbortController().signal);
      void agent.whenIdle().then(async () => {
        await ctx.sessions.flush(agent.session);
        if (!run.ended) run.error ||= 'DSH 未提供完整结束记录';
        run.status = run.cancelled ? 'cancelled' : run.error ? 'failed' : 'succeeded';
        touch(run);
        await save();
      }).catch(async error => { run.status = 'failed'; run.error = String(error.message ?? error); touch(run); await save(); });
      return publicRun(run);
    } catch (error) { run.status = 'failed'; run.error = String(error.message ?? error); touch(run); await save(); throw error; }
  }
  return {
    async route(route, method, input, url) {
      if (route === '/remote-policy' && method === 'POST') {
        const { enabled } = z.object({ enabled: z.boolean() }).strict().parse(input);
        remoteUntil = enabled ? Date.now() + 30000 : 0; return { ok: true };
      }
      if (route === '/runs' && method === 'GET') {
        const after = z.coerce.number().int().nonnegative().parse(url.searchParams.get('after') ?? 0);
        const rows = Object.values(commands).filter(r => (r.revision ?? 0) > after).sort((a, b) => a.revision - b.revision).slice(0, 8);
        return { runs: rows.map(publicRun), nextCursor: rows.at(-1)?.revision ?? after, hasMore: rows.length === 8 };
      }
      if (route === '/sessions' && method === 'GET') return catalog();
      if (route === '/history' && method === 'GET') return history(url.searchParams.get('id'), Number(url.searchParams.get('after') ?? -1));
      if (route === '/command' && method === 'GET') return publicRun(commands[uuid.parse(url.searchParams.get('id'))]);
      if (route === '/command' && method === 'POST') return submit(input);
      if (route === '/requests' && method === 'GET') return { requests: [...pending.values()].map(({ settle, ...p }) => p) };
      if (route === '/answer' && method === 'POST') {
        const value = z.object({ id: uuid, answer: z.string().max(16000) }).strict().parse(input);
        const item = pending.get(value.id);
        if (!item || item.state !== 'pending') throw new Error('确认请求已过期');
        if (item.kind === 'approval') {
          if (!['allow', 'reject'].includes(value.answer)) throw new Error('无效确认结果');
          item.settle(value.answer === 'allow' ? 'allowed-once' : 'rejected');
        } else {
          const answer = z.object({ answers: z.array(z.object({ id: z.string(), selected: z.array(z.string()), custom: z.string().optional() }).strict()) }).strict().parse(JSON.parse(value.answer));
          if (answer.answers.length !== item.questions.length || item.questions.some(q => answer.answers.filter(a => a.id === q.id).length !== 1)) throw new Error('请回答全部问题');
          item.settle(answer);
        }
        return { ok: true };
      }
      if (route === '/stop-command' && method === 'POST') {
        const run = commands[uuid.parse(input.id)];
        if (run?.status === 'running') { run.cancelled = true; ctx.sessionController.cancel({ sessionId: run.sessionId }); }
        return { requested: true };
      }
      return undefined;
    },
  };
}
