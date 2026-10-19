import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Engine } from './harness.mjs';
import { runProcess } from '../../../apps/desktop/src/native/process.mjs';

test('capability bridge fails closed, validates scope, keeps Codex sandbox and SSH host verification', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'dogo-capability-'));
  const engine = new Engine(root); t.after(async () => { await engine.close(); await rm(root, { recursive: true, force: true }); });
  const caps = engine.capabilities; await caps.start();
  let calls = [];
  caps.run = async (command, args, options) => { calls.push({ command, args, options }); return { code: 0, stdout: '{"type":"thread.started","thread_id":"fixture"}\n{"type":"item.completed","item":{"type":"agent_message","text":"CODEX_FIXTURE"}}\n{"type":"turn.completed"}\n', stderr: '', reason: '', truncated: false }; };
  await assert.rejects(caps.execute('codex', {}), /未授权/);
  const denied = await fetch(engine.dsh.capabilities.url, { method: 'POST', body: '{}' }); assert.equal(denied.status, 403);
  const cross = await fetch(engine.dsh.capabilities.url, { method: 'POST', headers: { Authorization: 'Bearer ' + caps.token, Origin: 'https://evil.test' }, body: '{}' }); assert.equal(cross.status, 403);
  await caps.configure({ computer: false, codex: true, sshHosts: ['fixture-host'] });
  await assert.rejects(caps.execute('ssh', { host: '-oProxyCommand=bad', command: 'true' }));
  await assert.rejects(caps.execute('ssh', { host: 'not-granted', command: 'true' }), /未授权/);
  const project = await engine.hub.register(await realpath(root));
  const result = await caps.execute('codex', { projectId: project.id, prompt: 'Synthetic only' });
  assert(result.success); assert.equal(result.output, 'CODEX_FIXTURE');
  assert(calls[0].args.includes('workspace-write')); assert(!calls[0].args.includes('--dangerously-bypass-approvals-and-sandbox'));
  assert.equal(calls[0].options.cwd, project.path);
  await caps.execute('ssh', { host: 'fixture-host', command: 'printf fixture', timeoutSeconds: 1 });
  assert(calls[1].args.includes('StrictHostKeyChecking=yes')); assert(calls[1].args.includes('BatchMode=yes')); assert.equal(calls[1].options.input, 'printf fixture');
  assert(!calls[1].args.includes('printf fixture'));
  await engine.hub.updateProject({ id: project.id, name: 'fixture', summary: '', published: true, executionAllowed: false });
  await assert.rejects(caps.execute('codex', { projectId: project.id, prompt: 'no' }), /授权失效/);
});

test('subprocesses return nonzero status, obey time/output limits and cancellation', async () => {
  const failed = await runProcess(process.execPath, ['-e', 'process.stderr.write("fixture error");process.exit(7)']);
  assert.equal(failed.code, 7); assert.equal(failed.stderr, 'fixture error');
  const limited = await runProcess(process.execPath, ['-e', 'process.stdout.write("x".repeat(100000))'], { limit: 100 }); assert(limited.truncated);
  const timed = await runProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeout: 50 }); assert.equal(timed.reason, 'timeout');
  const controller = new AbortController();
  const job = runProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { signal: controller.signal }); controller.abort();
  assert.equal((await job).reason, 'cancelled');
});

test('revoking a capability aborts its in-flight operation, and incomplete Codex output is not success', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'dogo-capability-revoke-')); const engine = new Engine(root);
  t.after(async () => { await engine.close(); await rm(root, { recursive: true, force: true }); });
  await engine.capabilities.configure({ computer: false, codex: true, sshHosts: ['fixture'] });
  let launched;
  const started = new Promise(r => { launched = r; });
  engine.capabilities.run = async (_command, _args, options) => { launched(); return runProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], options); };
  const running = engine.capabilities.execute('ssh', { host: 'fixture', command: '' + 'true' }); await started;
  await engine.capabilities.configure({ computer: false, codex: true, sshHosts: [] });
  const result = await running; assert.equal(result.reason, 'cancelled'); assert.equal(result.success, false);
  const p = await engine.hub.register(await realpath(root));
  engine.capabilities.run = async () => ({ code: 0, stdout: '{}', stderr: '', reason: '', truncated: false });
  assert.equal((await engine.capabilities.execute('codex', { projectId: p.id, prompt: 'fixture' })).success, false);
});

test('native runner receives the host environment including packaged helper and CLI paths', async () => {
  const { Capabilities } = await import('../../../apps/desktop/src/native/capabilities.mjs');
  let received;
  const env = { PATH: '/packaged/node:/local/bin', DOGO_MAC_HELPER: '/packaged/native/dogo-computer', SSH_AUTH_SOCK: '/synthetic/agent' };
  const caps = new Capabilities({ store: { value: (_key, fallback) => fallback } }, async (_cmd, _args, options) => { received = options; return { code: 0 }; }, env);
  await caps.run('codex', ['login', 'status'], { timeout: 1000 });
  assert.deepEqual(received.env, env); assert.equal(received.timeout, 1000);
});
