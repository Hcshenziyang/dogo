import { createServer } from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, writeFile, realpath, stat } from 'node:fs/promises';
import { once } from 'node:events';
import path from 'node:path';
import { z } from 'zod';
import { runProcess } from './process.mjs';

const alias = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/);
const policySchema = z.object({ computer: z.boolean(), codex: z.boolean(), sshHosts: z.array(alias).max(30) }).strict();
export class Capabilities {
  constructor(engine, runner = runProcess) {
    this.engine = engine; this.run = runner; this.active = new Map();
    this.policy = policySchema.parse(engine.store.value('capabilities', { computer: false, codex: false, sshHosts: [] }));
    this.token = randomBytes(32).toString('base64url');
  }
  snapshot() { return { policy: this.policy, active: this.active.size }; }
  async configure(value) {
    const next = policySchema.parse(value);
    for (const job of this.active.values()) if ((job.kind === 'computer' && !next.computer) || (job.kind === 'codex' && !next.codex) || (job.kind === 'ssh' && !next.sshHosts.includes(job.host))) job.controller.abort();
    this.policy = next; this.engine.store.setValue('capabilities', next); this.engine.changed(); return this.snapshot();
  }
  async start() {
    if (this.server) return;
    this.server = createServer(async (req, res) => {
      const reply = (status, value) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)); };
      const expected = Buffer.from('Bearer ' + this.token), given = Buffer.from(req.headers.authorization ?? '');
      if (req.headers.origin || req.method !== 'POST' || req.url !== '/execute' || req.headers.host !== `127.0.0.1:${this.server.address().port}` || expected.length !== given.length || !timingSafeEqual(expected, given)) { reply(403, { error: 'Forbidden' }); return; }
      const controller = new AbortController(); res.on('close', () => { if (!res.writableEnded) controller.abort(); });
      try {
        let body = ''; for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > 100000) throw new Error('请求过大'); }
        const input = z.object({ kind: z.enum(['computer', 'codex', 'ssh', 'status']), args: z.record(z.string(), z.unknown()) }).strict().parse(JSON.parse(body));
        reply(200, await this.execute(input.kind, input.args, controller.signal));
      } catch (e) { reply(400, { error: String(e.message).slice(0, 2000) }); }
    });
    this.server.listen(0, '127.0.0.1'); await once(this.server, 'listening');
    this.engine.dsh.capabilities = { url: `http://127.0.0.1:${this.server.address().port}/execute`, token: this.token };
  }
  async execute(kind, value, signal) {
    if (this.engine.closing) throw new Error('DogO 正在退出');
    if (kind === 'status') return { ...this.snapshot(), projects: this.engine.hub.projects.filter(p => p.available).map(p => ({ id: p.id, name: p.name })) };
    if (this.active.size >= 4 || (kind === 'computer' && [...this.active.values()].some(j => j.kind === 'computer'))) throw new Error('设备能力正在运行，请等待当前操作结束');
    const controller = new AbortController(), linked = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    let finish; const done = new Promise(resolve => { finish = resolve; });
    const id = randomUUID(), job = { kind, host: value.host, projectId: value.projectId, controller, done }; this.active.set(id, job);
    const options = { signal: linked, timeout: 20 * 60000 };
    try {
      if (kind === 'computer') {
        if (!this.policy.computer) throw new Error('电脑操作未授权，请在 DogO 设置启用');
        if (process.platform !== 'darwin' || !process.env.DOGO_MAC_HELPER) throw new Error('Mac 操作组件不可用');
        const input = z.object({ action: z.enum(['status', 'screenshot', 'click', 'type', 'key', 'scroll', 'activate']), x: z.number().optional(), y: z.number().optional(),
          text: z.string().max(4000).optional(), key: z.enum(['return', 'tab', 'escape', 'backspace', 'left', 'right', 'up', 'down', 'a', 'c', 'v']).optional(),
          modifiers: z.array(z.enum(['command', 'shift', 'option', 'control'])).max(4).optional(), button: z.enum(['left', 'right']).optional(),
          count: z.number().int().min(1).max(2).optional(), amount: z.number().int().min(-1000).max(1000).optional(), bundleId: z.string().max(200).optional() }).strict().parse(value);
        const r = await this.run(process.env.DOGO_MAC_HELPER, [], { ...options, input: JSON.stringify(input), limit: 20 * 1024 * 1024, timeout: 15000 });
        if (r.code !== 0) throw new Error('Mac 操作失败：' + (r.stderr || r.reason).slice(0, 1000));
        const result = JSON.parse(r.stdout);
        if (result.png) {
          const directory = path.join(this.engine.directory, 'computer-captures'); await mkdir(directory, { recursive: true, mode: 0o700 });
          const file = path.join(directory, id + '.png'); await writeFile(file, Buffer.from(result.png, 'base64'), { mode: 0o600, flag: 'wx' });
          delete result.png; return { ...result, path: file, instruction: '截图已保存。使用 DSH read_image 查看；如果当前模型不支持图像，请明确说明，不能猜测画面。坐标是全局屏幕点。' };
        }
        return result;
      }
      if (kind === 'codex') {
        if (!this.policy.codex) throw new Error('Codex 编码委派未授权，请在 DogO 设置启用');
        const input = z.object({ projectId: z.string().uuid(), prompt: z.string().min(1).max(64000) }).strict().parse(value);
        const project = this.engine.hub.projects.find(p => p.id === input.projectId && p.available && p.executionAllowed && p.published);
        if (!project || await realpath(project.path).catch(() => null) !== project.path || !(await stat(project.path)).isDirectory()) throw new Error('项目授权失效或目录不可用');
        const r = await this.run('codex', ['exec', '--json', '--color', 'never', '--sandbox', 'workspace-write', '--ignore-user-config', '--skip-git-repo-check', '-c', 'approval_policy="never"', '-C', project.path, '-'], { ...options, cwd: project.path, input: input.prompt });
        const events = r.stdout.split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
        const terminal = events.findLast(e => e.type === 'turn.completed' || e.type === 'turn.failed');
        const finished = terminal?.type === 'turn.completed';
        const errors = events.filter(e => e.type === 'turn.failed');
        // A reconnect diagnostic can precede a successful terminal event. Preserve it without reporting a failed task.
        const warnings = events.filter(e => e.type === 'error');
        const messages = events.filter(e => e.type === 'item.completed' && e.item?.type === 'agent_message').map(e => e.item.text);
        const result = { ...r, stdout: undefined, threadId: events.find(e => e.type === 'thread.started')?.thread_id,
          success: r.code === 0 && finished && !errors.length && !r.reason, output: messages.join('\n\n'),
          commands: events.filter(e => e.type === 'item.completed' && e.item?.type === 'command_execution').map(e => ({ command: e.item.command, exitCode: e.item.exit_code, output: e.item.aggregated_output })), errors, warnings };
        return this.record(id, kind, result);
      }
      if (kind === 'ssh') {
        const input = z.object({ host: alias, command: z.string().min(1).max(64000), timeoutSeconds: z.number().int().min(1).max(1200).default(120) }).strict().parse(value);
        if (!this.policy.sshHosts.includes(input.host)) throw new Error('SSH 目标未授权，请在 DogO 设置登记本机 SSH Host 别名');
        const r = await this.run('/usr/bin/ssh', ['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectionAttempts=1', '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=10', '-o', 'ServerAliveCountMax=2', '--', input.host, 'sh', '-s'], { ...options, input: input.command, timeout: input.timeoutSeconds * 1000 });
        return this.record(id, kind, { ...r, success: r.code === 0 && !r.reason, ...(r.reason || r.code === 255 ? { warning: '连接或本地进程已终止；远端副作用可能已发生，不能自动重试。后台远程进程不保证随 SSH 断开停止。' } : {}) });
      }
      throw new Error('未知设备能力');
    } finally { this.active.delete(id); finish(); }
  }
  async record(id, kind, value) {
    const directory = path.join(this.engine.directory, 'capability-results'); await mkdir(directory, { recursive: true, mode: 0o700 });
    const file = path.join(directory, id + '.json'); await writeFile(file, JSON.stringify({ kind, ...value }), { flag: 'wx', mode: 0o600 });
    const text = JSON.stringify(value); return text.length > 128000 ? { success: value.success, code: value.code, truncated: true, resultPath: file, output: text.slice(-120000), warning: '工具输出较长；完整有界执行记录见 resultPath' } : { ...value, resultPath: file };
  }
  async close() { const jobs = [...this.active.values()]; for (const job of jobs) job.controller.abort(); this.server?.closeAllConnections(); if (this.server) await new Promise(resolve => this.server.close(resolve)); await Promise.all(jobs.map(j => j.done)); }
}
