import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { Engine } from '../src/engine.mjs';
import { Relay } from '../src/relay.mjs';
import { createService } from '../../others/services/src/server.ts';
import { config, env } from '../../others/services/test/helpers.ts';

test('native controller runs stream to the relay, phone answers and cancels original turns, local answerer still works', { timeout: 90000 }, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'dogo-native-turns-'));
  let requests = 0;
  const model = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const input = JSON.parse(raw); if (input.tools?.length) requests++;
    const last = JSON.stringify(input.messages.filter(m => m.role === 'user'));
    const tools = input.messages.filter(m => m.role === 'tool');
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: 'native-fixture', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    if (!input.tools?.length) {
      send({ role: 'assistant', content: 'Synthetic fixture title' }); send({}, 'stop'); res.end('data: [DONE]\n\n');
    } else if (last.includes('QUESTION_731') && !tools.length) {
      send({ role: 'assistant', tool_calls: [{ index: 0, id: 'question731', type: 'function', function: { name: 'ask_user_question', arguments: JSON.stringify({ questions: [{ id: 'fixture', question: 'Synthetic test choice?', options: [{ label: 'OK' }] }] }) } }] });
      send({}, 'tool_calls'); res.end('data: [DONE]\n\n');
    } else if (last.includes('STALL_731')) {
      send({ role: 'assistant', content: 'NATIVE_PARTIAL_731' });
      const timeout = setTimeout(() => res.end('data: [DONE]\n\n'), 60000); res.on('close', () => clearTimeout(timeout));
    } else {
      send({ role: 'assistant', content: tools.some(m => JSON.stringify(m).includes('LOCAL_ANSWER_731')) ? 'LOCAL_PASSED_731' : tools.length ? 'REMOTE_PASSED_731' : 'NATIVE_DONE_731' });
      send({}, 'stop'); res.end('data: [DONE]\n\n');
    }
  });
  model.listen(0, '127.0.0.1'); await once(model, 'listening');
  const service = createService(config(path.join(root, 'relay.sqlite')), env); const address = await service.listen();
  const engine = new Engine(path.join(root, 'local'));
  t.after(async () => { await engine.close(); await service.close(); model.closeAllConnections(); model.close(); await rm(root, { recursive: true, force: true }); });
  engine.configure({ ...engine.store.settings(), endpoint: `http://127.0.0.1:${model.address().port}/v1`, model: 'fixture' });
  await engine.dsh.ensure(engine.store.settings()); await engine.dsh.stop();
  const fixture = fileURLToPath(new URL('./native-fixture.mjs', import.meta.url));
  await writeFile(path.join(engine.dsh.home, 'profiles/dogo/cordis.patch.yml'), `- insert:\n    - id: native-test-only\n      name: ${JSON.stringify(fixture)}\n`);
  await engine.dsh.ensure(engine.store.settings());
  engine.relay = new Relay(engine, (url, options) => fetch(url.replace('https://fixture.test', address), options));
  await engine.hub.configure({ autoExecute: true });
  await engine.relay.connect({ version: 1, url: 'https://fixture.test', device: 'mac', token: env.DOGO_MAC_TOKEN });
  clearInterval(engine.relay.timer); clearInterval(engine.relay.streamTimer);
  const native = async (prompt, localAnswer = false) => {
    const response = await fetch(engine.dsh.url + '/fixture-native', { method: 'POST', headers: { Authorization: `Bearer ${engine.dsh.token}` }, body: JSON.stringify({ prompt, localAnswer }) });
    assert.equal(response.status, 200); return (await response.json()).sessionId;
  };
  const phone = (op, args) => service.hub.execute(service.store.config.devices.find(d => d.id === 'phone'), op, args);
  const wait = async predicate => {
    for (let n = 0; n < 150; n++) { await engine.relay.refresh(); const value = predicate(); if (value) return value; await delay(100); }
    throw new Error('Native fixture timed out: ' + JSON.stringify({ hub: engine.hub.state, relay: engine.relay.snapshot(), runs: await engine.dsh.request('/runs?after=0'), tail: engine.dsh.tail }));
  };
  const sessionId = await native('STALL_731. Synthetic only; no tools.');
  const command = await wait(() => service.hub.all('command').find(c => c.createdBy === 'native' && c.result.includes('NATIVE_PARTIAL_731')));
  assert.equal(command.status, 'running'); assert.equal(requests, 1);
  assert.equal(service.hub.get('session', command.sessionId).nativeId, sessionId);
  phone('stop', { id: command.id });
  await wait(() => service.hub.get('command', command.id).status === 'cancelled'); assert.equal(requests, 1);
  const questionSession = await native('QUESTION_731: call ask_user_question now.');
  const question = await wait(() => service.hub.all('request').find(r => r.state === 'pending' && service.hub.get('session', r.sessionId).nativeId === questionSession));
  phone('answer', { id: question.id, answer: JSON.stringify({ answers: [{ id: 'fixture', selected: [], custom: 'REMOTE_ANSWER_731' }] }) });
  await wait(() => service.hub.all('command').find(c => c.sessionId === question.sessionId && c.status === 'succeeded' && c.result.includes('REMOTE_PASSED_731')));
  const history = phone('history', { sessionId: question.sessionId });
  const tool = history.messages.find(m => m.role === 'tool'); assert(tool?.hasDetails); assert.equal(tool.detail, undefined);
  assert(phone('details', { sessionId: question.sessionId, messageId: tool.id }).detail);
  const localSession = await native('QUESTION_731: call ask_user_question now.', true);
  await wait(() => service.hub.all('command').find(c => c.status === 'succeeded' && c.result.includes('LOCAL_PASSED_731') && service.hub.get('session', c.sessionId).nativeId === localSession));
  assert(!service.hub.all('request').some(r => r.state === 'pending' && service.hub.get('session', r.sessionId).nativeId === localSession));
});
