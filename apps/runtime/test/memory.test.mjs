import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { once } from 'node:events';
import { Engine } from '../src/engine.mjs';
import { createService } from '../../others/services/src/server.ts';
import { config, env } from '../../others/services/test/helpers.ts';

test('memory conflict uses a separate real DSH session; merges independent fixture facts and defers uncertain content', { timeout: 60000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dogo-memory-agent-'));
  const service = createService(config(path.join(root, 'relay.sqlite')), env), url = await service.listen();
  let decision = 'merge', modelCalls = 0;
  const model = http.createServer(async (req, res) => {
    for await (const _ of req) {} modelCalls++;
    const content = JSON.stringify({ decision, content: decision === 'merge' ? 'base\nfrom mac\nfrom phone' : null, reason: 'Synthetic fixture' });
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (const [delta, finish_reason] of [[{ role: 'assistant', content }, null], [{}, 'stop']])
      res.write(`data: ${JSON.stringify({ id: 'memory-fixture', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  model.listen(0, '127.0.0.1'); await once(model, 'listening');
  const engine = new Engine(path.join(root, 'mac'));
  t.after(async () => { await engine.close(); await service.close(); model.closeAllConnections(); model.close(); await rm(root, { recursive: true, force: true }); });
  engine.configure({ ...engine.store.settings(), endpoint: `http://127.0.0.1:${model.address().port}/v1`, model: 'fixture' });
  engine.relay.key = { url, device: 'mac', token: env.DOGO_MAC_TOKEN };
  await engine.memory.configure({ enabled: true }); await engine.hub.configure({ autoExecute: true });
  const phone = async (op, args) => {
    const response = await fetch(url + '/v2/memory', { method: 'POST', headers: { Authorization: `Bearer ${env.DOGO_PHONE_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ op, args }) });
    assert.equal(response.status, 200); return response.json();
  };
  await phone('write', { path: 'fixture.md', baseVersion: 0, content: 'base' }); await engine.memory.sync();
  await writeFile(path.join(engine.memory.folder, 'fixture.md'), 'base\nfrom mac');
  await phone('write', { path: 'fixture.md', baseVersion: 1, content: 'base\nfrom phone' }); await engine.memory.sync();
  assert.equal(engine.memory.state.error, '');
  assert.equal((await phone('conflicts', {})).conflicts[0].status, 'resolved');
  await engine.memory.sync(); assert.equal(await readFile(path.join(engine.memory.folder, 'fixture.md'), 'utf8'), 'base\nfrom mac\nfrom phone');
  assert.equal(engine.store.tasks().length, 0, 'maintenance never pollutes work task records');
  const sessions = (await engine.dsh.request('/sessions')).sessions;
  assert.equal(sessions.length, 1); assert.equal(sessions[0].readOnly, true);
  decision = 'human';
  await phone('write', { path: 'uncertain.md', baseVersion: 0, content: 'base' }); await engine.memory.sync();
  await writeFile(path.join(engine.memory.folder, 'uncertain.md'), 'delete this fact');
  await phone('write', { path: 'uncertain.md', baseVersion: 1, content: 'keep this fact' }); await engine.memory.sync();
  const conflict = (await phone('conflicts', {})).conflicts.find(c => c.path === 'uncertain.md');
  assert.equal(conflict.status, 'needs-human'); assert.equal(conflict.local, 'delete this fact'); assert.equal(conflict.remote, 'keep this fact');
  const count = modelCalls; await engine.memory.sync(); assert.equal(modelCalls, count, 'no automatic retry loop');
});
