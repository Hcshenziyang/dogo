import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import http from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { DesktopHost } from '../src/host/client.mjs';
import { Store } from '../../../packages/dsh-plugin/src/host/store.mjs';

test('real DSH presents one memory entry, routes scopes, persists through restart and exposes files in settings', { timeout: 90000 }, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'dogo-memory-native-'));
  let wanted, called = false;
  const requests = [], replies = [];
  const model = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const input = JSON.parse(raw);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: 'memory-test', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    if (!input.tools?.length) {
      send({ role: 'assistant', content: 'Memory fixture title' }); send({}, 'stop');
    } else if (!called) {
      requests.push(input); called = true;
      send({ role: 'assistant', tool_calls: [{ index: 0, id: 'memory-' + randomUUID(), type: 'function',
        function: { name: 'dogo_memory', arguments: JSON.stringify(wanted) } }] });
      send({}, 'tool_calls');
    } else {
      replies.push(input.messages.filter(message => message.role === 'tool').at(-1));
      send({ role: 'assistant', content: 'MEMORY_TOOL_FINISHED' }); send({}, 'stop');
    }
    res.end('data: [DONE]\n\n');
  });
  model.listen(0, '127.0.0.1'); await once(model, 'listening');
  const store = new Store(root);
  store.configure({ ...store.settings(), model: 'fixture', endpoint: `http://127.0.0.1:${model.address().port}/v1` }); store.close();
  let host = new DesktopHost(root);
  t.after(async () => { await host.close(); model.closeAllConnections(); model.close(); await rm(root, { recursive: true, force: true }); });
  await host.start();
  async function turn(args) {
    wanted = args; called = false;
    const requestId = randomUUID(), sessionId = 'session-' + randomUUID();
    await host.backend.request('/command', { requestId, sessionId, create: true, prompt: 'Synthetic memory integration fixture; perform the requested tool operation.' });
    for (let i = 0; i < 200; i++) {
      const run = await host.backend.request('/command?id=' + requestId);
      if (run.status !== 'running') {
        assert.equal(run.status, 'succeeded', JSON.stringify(run));
        return sessionId;
      }
      await delay(50);
    }
    throw new Error('Memory tool did not settle');
  }
  const sessionId = await turn({ action: 'create', scope: 'personal', text: 'Fixture interest in full duplex voice', related: [{ scope: 'topic', scopeId: 'voice-study' }] });
  const names = requests[0].tools.map(tool => tool.function.name);
  assert(names.includes('dogo_memory'), JSON.stringify(names));
  assert(!names.some(name => /^memory_/.test(name)), JSON.stringify(names));
  assert(JSON.stringify(requests[0].messages).includes('不是“概要/详情”分层'));
  const status = await host.request('memoryAction', { op: 'status' });
  assert.equal(status.automatic, true); assert.equal(status.enabled, true);
  assert.equal(status.files.length, 1, JSON.stringify(replies));
  const personalPath = status.files[0];
  const personal = JSON.parse((await host.request('memoryAction', { op: 'read', args: { path: personalPath } })).content);
  assert.equal(personal.scope, 'personal'); assert.equal(personal.source.sessionId, sessionId);
  assert.equal(typeof personal.source.seq, 'number');
  await turn({ action: 'create', scope: 'topic', scopeId: 'voice-study', text: 'Fixture source https://example.test; observed 2026-10-20', related: [{ scope: 'personal', id: personal.id }] });
  assert.equal((await host.request('memoryAction', { op: 'status' })).files.length, 2);
  assert(JSON.stringify(requests.at(-1).messages).includes('Fixture interest in full duplex voice'), 'personal notes are available in a different session');
  await turn({ action: 'create', scope: 'project', text: 'must fail without scopeId' });
  assert.equal((await host.request('memoryAction', { op: 'status' })).files.length, 2);
  assert.match(JSON.stringify(replies.at(-1)), /scopeId/);
  await host.close(); host = new DesktopHost(root); await host.start();
  await turn({ action: 'search', scope: 'topic', scopeId: 'voice-study', query: 'example.test' });
  assert.match(JSON.stringify(replies.at(-1)), /example\.test/);
  const oldText = 'Old duplicate personal fixture';
  await host.request('memoryAction', { op: 'write', args: { path: 'old-fixture.md', content: oldText, base: null } });
  await turn({ action: 'legacy_read', scope: 'personal', path: 'old-fixture.md' });
  const oldVersion = createHash('sha256').update(oldText).digest('hex');
  assert(JSON.stringify(replies.at(-1)).includes(oldVersion));
  await turn({ action: 'legacy_forget', scope: 'personal', path: 'old-fixture.md', version: oldVersion });
  assert.equal((await host.request('memoryAction', { op: 'read', args: { path: 'old-fixture.md' } })).content, null);
  await host.request('memoryAction', { op: 'configure', args: { automatic: false } });
  await turn({ action: 'create', scope: 'personal', text: 'must not save while disabled' });
  assert.match(JSON.stringify(replies.at(-1)), /disabled/);
  assert.equal((await host.request('memoryAction', { op: 'status' })).files.length, 2);
});
