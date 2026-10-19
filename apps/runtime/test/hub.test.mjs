import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import http from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { Engine } from '../src/engine.mjs';

test('normal DSH controller keeps native session identity, history and deduplicates remote prompts across restart', { timeout: 90000 }, async t => {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    requests.push(JSON.parse(body));
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const [delta, finish_reason] of [[{ role: 'assistant', content: 'HUB_FIXTURE_OK' }, null], [{}, 'stop']])
      res.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: 'fixture', choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const root = await mkdtemp(path.join(tmpdir(), 'dogo-hub-test-'));
  const cwd = path.join(root, 'synthetic'); await mkdir(cwd);
  const engine = new Engine(path.join(root, 'state'));
  t.after(async () => { await engine.close(); server.closeAllConnections(); server.close(); await rm(root, { recursive: true, force: true }); });
  engine.configure({ ...engine.store.settings(), endpoint: `http://127.0.0.1:${server.address().port}/v1`, model: 'fixture' });
  await engine.dsh.ensure(engine.store.settings());
  const sessionId = `session-${randomUUID()}`; // Native DSH UI IDs are not bare UUIDs.
  const first = { sessionId, requestId: randomUUID(), create: true, cwd, prompt: 'Synthetic test, reply briefly. Do not call any tools.' };
  const wait = async id => {
    for (let n = 0; n < 200; n++) { const run = await engine.dsh.request(`/command?id=${id}`); if (run.status !== 'running') return run; await delay(100); }
    throw new Error('DSH did not finish');
  };
  await engine.dsh.request('/command', first);
  const done = await wait(first.requestId);
  assert.equal(done.status, 'succeeded', done.error);
  assert.equal(done.output, 'HUB_FIXTURE_OK');
  assert((await engine.dsh.request('/sessions')).sessions.some(s => s.nativeId === sessionId && !s.readOnly));
  const history = await engine.dsh.request(`/history?id=${sessionId}&after=-1`);
  assert(history.messages.some(m => m.role === 'assistant' && m.text === 'HUB_FIXTURE_OK'));
  assert(!history.messages.some(m => m.text.includes('Current runtime context')), 'model-only runtime context must not appear as a user message on other devices');
  assert(!history.messages.some(m => m.text.includes(cwd)), 'runtime workspace paths are not project metadata for publication');
  assert(history.messages.every(m => Number.isFinite(m.at)), 'wire history timestamps are numeric');
  const count = requests.length;
  await engine.dsh.request('/command', first);
  assert.equal(requests.length, count);
  const origin = new URL(engine.dsh.webUrl).origin;
  await engine.dsh.stop(); await engine.dsh.ensure(engine.store.settings());
  assert.equal(new URL(engine.dsh.webUrl).origin, origin, 'draft storage keeps the same origin after backend restart');
  await engine.dsh.request('/command', first);
  assert.equal(requests.length, count);
  const second = { sessionId, requestId: randomUUID(), create: false, prompt: 'Continue in the same session.' };
  await engine.dsh.request('/command', second);
  assert.equal((await wait(second.requestId)).status, 'succeeded');
  assert(requests.at(-1).messages.some(m => m.role === 'assistant' && JSON.stringify(m.content).includes('HUB_FIXTURE_OK')));
  assert(requests.at(-1).tools.some(tool => tool.function.name !== 'read_workspace_file'), 'normal upstream tools remain available');
});

test('remote human question resumes the original upstream DSH tool call and cancel closes a pending request', { timeout: 60000 }, async t => {
  let calls = 0;
  const server = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const input = JSON.parse(body); calls++;
    const answered = input.messages.some(m => m.role === 'tool' && JSON.stringify(m.content).includes('FIXTURE_REPLY'));
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: 'question-fixture', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    if (answered || !input.tools) { send({ role: 'assistant', content: 'ANSWER_RECEIVED' }); send({}, 'stop'); }
    else {
      assert(input.tools.some(t => t.function.name === 'ask_user_question'));
      send({ role: 'assistant', tool_calls: [{ index: 0, id: `ask${calls}`, type: 'function', function: { name: 'ask_user_question', arguments: JSON.stringify({ questions: [{ id: 'fixture', question: 'Synthetic choice?', options: [{ label: 'OK' }] }] }) } }] });
      send({}, 'tool_calls');
    }
    res.end('data: [DONE]\n\n');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const root = await mkdtemp(path.join(tmpdir(), 'dogo-questions-'));
  const engine = new Engine(root);
  t.after(async () => { await engine.close(); server.closeAllConnections(); server.close(); await rm(root, { recursive: true, force: true }); });
  engine.configure({ ...engine.store.settings(), endpoint: `http://127.0.0.1:${server.address().port}/v1`, model: 'fixture' });
  await engine.dsh.ensure(engine.store.settings());
  const waitRequest = async () => {
    for (let n = 0; n < 150; n++) {
      const found = (await engine.dsh.request('/requests')).requests.find(r => r.state === 'pending');
      if (found) return found; await delay(100);
    }
    throw new Error('Question never reached phone bridge');
  };
  const first = { requestId: randomUUID(), sessionId: randomUUID(), create: true, prompt: 'Ask one synthetic question.' };
  await engine.dsh.request('/command', first);
  const question = await waitRequest(); assert.equal(question.sessionId, first.sessionId);
  assert((await engine.executionStatus()).active > 0, 'quit checks native DSH activity, even without a relay command index');
  await engine.dsh.request('/answer', { id: question.id, answer: JSON.stringify({ answers: [{ id: 'fixture', selected: [], custom: 'FIXTURE_REPLY' }] }) });
  let result;
  for (let n = 0; n < 100; n++) { result = await engine.dsh.request(`/command?id=${first.requestId}`); if (result.status !== 'running') break; await delay(100); }
  assert.equal(result.status, 'succeeded', result.error); assert.equal(result.output, 'ANSWER_RECEIVED');
  assert.deepEqual(await engine.executionStatus(), { active: 0, unknown: false });
  const second = { requestId: randomUUID(), sessionId: randomUUID(), create: true, prompt: 'Ask then wait for cancellation.' };
  await engine.dsh.request('/command', second); const cancel = await waitRequest();
  await engine.dsh.request('/stop-command', { id: second.requestId });
  for (let n = 0; n < 100; n++) { result = await engine.dsh.request(`/command?id=${second.requestId}`); if (result.status !== 'running') break; await delay(100); }
  assert.equal(result.status, 'cancelled');
  await assert.rejects(engine.dsh.request('/answer', { id: cancel.id, answer: '{}' }), /过期/);
});
