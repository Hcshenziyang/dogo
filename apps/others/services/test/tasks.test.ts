import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { request } from 'node:http';
import { rmSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Store } from '../src/store.ts';
import type { Task } from '../src/schema.ts';
import { configSchema, memoryPath } from '../src/schema.ts';
import { createService } from '../src/server.ts';
import { ServiceClient } from '../src/client.ts';
import { config, env, fixture, taskInput, temp } from './helpers.ts';

async function readEvent(reader: ReadableStreamDefaultReader<Uint8Array>) {
  let text = '';
  while (!/data: .+\n\n/.test(text)) {
    const chunk = await reader.read();
    if (chunk.done) throw new Error('Stream ended before event');
    text += new TextDecoder().decode(chunk.value);
  }
  return text;
}

test('phone -> offline Mac queue -> claim/progress/result -> offline phone replay', async t => {
  const f = await fixture(t);
  const created = await f.phone.request<Task & { executorOnline: boolean }>('/v1/tasks', 'POST', taskInput);
  assert.equal(created.status, 'queued');
  assert.equal(created.sender, 'phone');
  assert.equal(created.executorOnline, false);
  const pending = await f.mac.request<{ tasks: Task[] }>('/v1/tasks');
  assert.equal(pending.tasks[0].id, created.id);
  await f.mac.request('/v1/heartbeat', 'POST');
  const claim = await f.mac.request<Task>(`/v1/tasks/${created.id}/claim`, 'POST', { executionId: 'run-1' });
  assert.equal(claim.status, 'running');
  await f.mac.request(`/v1/tasks/${created.id}/progress`, 'POST', { executionId: 'run-1', message: 'Reading files' });
  f.setTime(150_001);
  await f.mac.request('/v1/heartbeat', 'POST');
  const unknown = await f.phone.request<{ executionUnknown: boolean; status: string }>(`/v1/tasks/${created.id}`);
  assert.equal(unknown.executionUnknown, true);
  assert.equal(unknown.status, 'running');
  await assert.rejects(f.mac.request(`/v1/tasks/${created.id}/claim`, 'POST', { executionId: 'run-2' }), /already claimed/);
  const finish = { executionId: 'run-1', status: 'succeeded', result: 'Read complete. No tests were run.' };
  await f.mac.request(`/v1/tasks/${created.id}/finish`, 'POST', finish);
  await f.mac.request(`/v1/tasks/${created.id}/finish`, 'POST', finish);
  const result = await f.phone.request<Task>(`/v1/tasks/${created.id}`);
  assert.equal(result.result, finish.result);
  const events = await f.phone.request<{ events: { kind: string }[]; nextCursor: number }>('/v1/events?after=0');
  assert.deepEqual(events.events.map(e => e.kind), ['task.created', 'task.claimed', 'task.progress', 'task.finished']);
  const tail = await f.phone.request<{ events: unknown[] }>(`/v1/events?after=${events.nextCursor}`);
  assert.equal(tail.events.length, 0);
});

test('create and claim are idempotent, stale writers cannot finish', async t => {
  const { phone, mac } = await fixture(t);
  const [a, b] = await Promise.all([
    phone.request<Task>('/v1/tasks', 'POST', taskInput), phone.request<Task>('/v1/tasks', 'POST', taskInput),
  ]);
  assert.equal(a.id, b.id);
  await assert.rejects(phone.request('/v1/tasks', 'POST', { ...taskInput, title: 'changed' }), /different task/);
  const path = `/v1/tasks/${a.id}`;
  const attempts = await Promise.allSettled(['a', 'b'].map(executionId => mac.request<Task>(`${path}/claim`, 'POST', { executionId })));
  assert.equal(attempts.filter(r => r.status === 'fulfilled').length, 1);
  const current = await phone.request<Task>(path);
  const same = await mac.request<Task>(`${path}/claim`, 'POST', { executionId: current.executionId });
  assert.equal(same.executionId, current.executionId);
  await assert.rejects(mac.request(`${path}/finish`, 'POST', { executionId: 'stale', status: 'succeeded', result: 'bad' }), /mismatch/);
  await mac.request(`${path}/finish`, 'POST', { executionId: current.executionId, status: 'failed', result: 'Tool failed' });
  await assert.rejects(mac.request(`${path}/progress`, 'POST', { executionId: current.executionId, message: 'late' }), /mismatch/);
});

test('mailbox, result, memory and executor permissions are isolated', async t => {
  const { phone, mac, win } = await fixture(t);
  const task = await phone.request<Task>('/v1/tasks', 'POST', taskInput);
  await assert.rejects(win.request('/v1/tasks', 'POST', taskInput), /not allowed/);
  await assert.rejects(win.request(`/v1/tasks/${task.id}`), /not found/);
  await assert.rejects(phone.request(`/v1/tasks/${task.id}/claim`, 'POST', { executionId: 'wrong' }), /assigned executor/);
  await assert.rejects(win.request('/v1/memory'), /not allowed/);
  await assert.rejects(phone.request('/v1/tasks', 'POST', { ...taskInput, sender: 'mac' }), /Invalid request/);
  const events = await win.request<{ events: unknown[] }>('/v1/events');
  assert.equal(events.events.length, 0);
  const tasks = await mac.request<{ tasks: Task[] }>('/v1/tasks');
  assert.equal(tasks.tasks.length, 1);
});

test('durable tasks, results and replay survive restart; claim is never automatically recycled', t => {
  const root = temp();
  const cfg = config(join(root, 'persistent.sqlite'));
  const phone = cfg.devices[1], mac = cfg.devices[0];
  let store = new Store(cfg);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const task = store.create(phone, taskInput);
  store.claim(mac, task.id, 'persistent-run');
  store.heartbeat(mac);
  store.close();
  store = new Store(cfg);
  assert.equal(store.task(phone, task.id).status, 'running');
  assert.equal(store.task(phone, task.id).executionUnknown, true);
  assert.throws(() => store.claim(mac, task.id, 'new-run'), /already claimed/);
  store.finish(mac, task.id, { executionId: 'persistent-run', status: 'succeeded', result: 'done' });
  store.close();
  store = new Store(cfg);
  assert.equal(store.task(phone, task.id).result, 'done');
  assert.equal(store.events(phone, 0).length, 3);
});

test('SSE pushes committed changes and reconnect replays with a cursor', { timeout: 5000 }, async t => {
  const f = await fixture(t);
  const task = await f.phone.request<Task>('/v1/tasks', 'POST', taskInput);
  const abort = new AbortController();
  const response = await fetch(`${f.url}/v1/events/stream?after=0`, { headers: { Authorization: `Bearer ${env.DOGO_MAC_TOKEN}` }, signal: abort.signal });
  assert.equal(response.status, 200);
  const reader = response.body!.getReader();
  const text = await readEvent(reader);
  assert.match(text, /task.created/);
  assert.match(text, new RegExp(task.id));
  const sequence = /id: (\d+)/.exec(text)![1];
  abort.abort();
  await reader.cancel().catch(() => {});
  await f.mac.request(`/v1/tasks/${task.id}/claim`, 'POST', { executionId: 'sse-run' });
  const controller = new AbortController();
  const resumed = await fetch(`${f.url}/v1/events/stream`, { headers: { Authorization: `Bearer ${env.DOGO_MAC_TOKEN}`, 'Last-Event-ID': sequence }, signal: controller.signal });
  const resumedReader = resumed.body!.getReader();
  const update = await readEvent(resumedReader);
  assert.match(update, /task.claimed/);
  assert.doesNotMatch(update, /task.created/);
  await f.mac.request(`/v1/tasks/${task.id}/progress`, 'POST', { executionId: 'sse-run', message: 'live update' });
  assert.match(await readEvent(resumedReader), /task.progress/);
  controller.abort();
  await resumedReader.cancel().catch(() => {});
});

test('official MCP client can initialize, list tools, create/read task and receive authorization errors', async t => {
  const f = await fixture(t);
  const client = new Client({ name: 'dogo-integration-test', version: '0.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${f.url}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${env.DOGO_PHONE_TOKEN}` } },
  });
  await client.connect(transport);
  t.after(() => client.close());
  const tools = await client.listTools();
  assert.deepEqual(new Set(tools.tools.map(t => t.name)), new Set(['task_create', 'task_list', 'task_get', 'task_claim', 'task_progress', 'task_finish',
    ...['snapshot', 'history', 'details', 'create', 'send', 'stop', 'note', 'noteState', 'answer', 'artifactBegin', 'artifactChunk', 'artifactSeal', 'artifactRead'].map(op => 'dogo_' + op),
    ...['list', 'read', 'write', 'conflicts'].map(op => 'personal_memory_' + op)]));
  const response = await client.callTool({ name: 'task_create', arguments: taskInput });
  assert.notEqual(response.isError, true);
  const content = response.content as { type: string; text: string }[];
  const task: Task = JSON.parse(content[0].text);
  assert.equal(task.sender, 'phone');
  const forbidden = await client.callTool({ name: 'task_claim', arguments: { taskId: task.id, executionId: 'bad' } });
  assert.equal(forbidden.isError, true);
  const read = await client.callTool({ name: 'task_get', arguments: { taskId: task.id } });
  assert.notEqual(read.isError, true);
});

test('reject unauthenticated, browser-origin, wrong-host and malformed input', async t => {
  const { url } = await fixture(t);
  assert.equal((await fetch(`${url}/v1/tasks`)).status, 401);
  const headers = { Authorization: `Bearer ${env.DOGO_PHONE_TOKEN}` };
  assert.equal((await fetch(`${url}/v1/tasks`, { headers: { ...headers, Origin: 'https://evil.example' } })).status, 403);
  const wrongHost = await new Promise<number | undefined>((resolve, reject) => {
    request(`${url}/v1/tasks`, { headers: { ...headers, Host: 'evil.example' } }, response => {
      response.resume(); resolve(response.statusCode);
    }).on('error', reject).end();
  });
  assert.equal(wrongHost, 403);
  assert.equal((await fetch(`${url}/v1/events?after=-1`, { headers })).status, 400);
  assert.equal((await fetch(`${url}/v1/tasks`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: '{' })).status, 400);
  assert.equal((await fetch(`${url}/v1/tasks`, { method: 'POST', headers, body: '{}' })).status, 415);
  const oversized = await fetch(`${url}/v1/tasks`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ data: 'a'.repeat(1024 * 1024) }) });
  assert.equal(oversized.status, 413);
});

test('configuration validates identities, routes, tokens and transport', () => {
  assert.throws(() => createService(config(), {}), /DOGO_MAC_TOKEN/);
  assert.throws(() => createService(config(), { ...env, DOGO_WIN_TOKEN: env.DOGO_MAC_TOKEN }), /unique/);
  assert.throws(() => configSchema.parse({ ...config(), mailboxes: { '/tasks/mac': 'missing' } }));
  assert.throws(() => configSchema.parse({ ...config(), devices: [config().devices[0], config().devices[0]] }));
  assert.throws(() => new ServiceClient('http://example.com', env.DOGO_PHONE_TOKEN), /HTTPS/);
  assert.throws(() => new ServiceClient('https://user:secret@example.com', env.DOGO_PHONE_TOKEN), /without credentials/);
});

test('event pagination does not skip a large offline backlog', t => {
  const store = new Store(config());
  t.after(() => store.close());
  for (let i = 0; i < 130; i++) store.create(config().devices[1], { ...taskInput, requestId: `r-${i}` });
  const first = store.events(config().devices[0], 0);
  const second = store.events(config().devices[0], first.at(-1)!.seq);
  assert.equal(first.length, 100);
  assert.equal(second.length, 30);
  assert.equal(new Set([...first, ...second].map(e => e.resource)).size, 130);
});

test('task and event transaction rolls back together', t => {
  const store = new Store(config());
  t.after(() => store.close());
  store.db.exec("CREATE TRIGGER fail_event BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT, 'injected failure'); END");
  assert.throws(() => store.create(config().devices[1], taskInput), /injected failure/);
  assert.equal(store.tasks(config().devices[1]).tasks.length, 0);
});

test('memory paths reject traversal, hidden files and nonportable names', () => {
  for (const path of ['../secret.md', '/absolute.md', 'dir\\bad.md', '.env', '.ssh/key.txt', 'con.md', 'a/../b.md', 'A.md', 'nested/.hidden/x.md']) {
    assert.equal(memoryPath.safeParse(path).success, false, path);
  }
  assert.equal(memoryPath.safeParse('personal/preferences.md').success, true);
});

test('task-only and memory-only service deployments can be selected', async t => {
  for (const services of [['tasks'], ['memory']] as const) {
    const service = createService({ ...config(), services }, env);
    const url = await service.listen();
    t.after(() => service.close());
    const headers = { Authorization: `Bearer ${env.DOGO_PHONE_TOKEN}` };
    assert.equal((await fetch(`${url}/v1/${services[0] === 'tasks' ? 'memory' : 'tasks'}`, { headers })).status, 404);
  }
});
