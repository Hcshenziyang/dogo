import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Engine } from './harness.mjs';
import { Relay } from '../src/host/relay.mjs';
import { createService } from '../../../apps/others/services/src/server.ts';
import { config, env } from '../../../apps/others/services/test/helpers.ts';

test('v2 auto execution, lost claim/admission response, same-session continuation and notes-only receipt', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dogo-hub-relay-'));
  const service = createService(config(path.join(root, 'relay.sqlite')), env), url = await service.listen();
  const engine = new Engine(path.join(root, 'local'));
  t.after(async () => { await engine.close(); await service.close(); await rm(root, { recursive: true, force: true }); });
  engine.store.configure({ ...engine.store.settings(), model: 'fixture' });
  let loseClaim = false, loseAdmission = false, admissions = 0;
  const sessions = [], runs = new Map();
  engine.dsh.ensure = async () => {};
  engine.dsh.request = async (route, value) => {
    if (route === '/remote-policy') return { ok: true };
    if (route === '/sessions') return { sessions };
    if (route === '/requests') return { requests: [] };
    if (route.startsWith('/history')) return { messages: [], cursor: -1 };
    if (route === '/command') {
      admissions++;
      if (!sessions.some(s => s.nativeId === value.sessionId)) sessions.push({ nativeId: value.sessionId, cwd: root, title: 'fixture', state: 'idle', cursor: -1, readOnly: false });
      runs.set(value.requestId, { status: 'succeeded', output: 'synthetic result' });
      if (loseAdmission) { loseAdmission = false; throw new Error('admission response lost'); }
      return runs.get(value.requestId);
    }
    if (route.startsWith('/command?id=')) return runs.get(route.split('=')[1]);
    throw new Error('Unexpected route ' + route);
  };
  engine.relay = new Relay(engine, async (target, opts) => {
    const response = await fetch(target.replace('https://relay.example', url), opts);
    if (opts.body && JSON.parse(opts.body).op === 'claim' && loseClaim) { loseClaim = false; throw new Error('claim response lost'); }
    return response;
  });
  await engine.hub.configure({ autoExecute: true });
  await engine.relay.connect({ version: 1, device: 'mac', url: 'https://relay.example', token: env.DOGO_MAC_TOKEN });
  clearInterval(engine.relay.timer);
  const phone = async (op, args) => {
    const response = await fetch(url + '/v2/hub', { method: 'POST', headers: { Authorization: `Bearer ${env.DOGO_PHONE_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ op, args }) });
    assert.equal(response.status, 200); return response.json();
  };
  const note = await phone('note', { requestId: randomUUID(), target: 'mac', title: 'Fixture note', text: 'Never execute me' });
  await engine.relay.refresh(); assert.equal(admissions, 0); assert.equal(service.hub.get('note', note.id).state, 'received');
  loseClaim = true;
  const first = await phone('create', { requestId: randomUUID(), target: 'mac', title: 'Fixture task', prompt: 'Synthetic only' });
  await engine.relay.refresh(); assert.equal(admissions, 0);
  const executionId = service.hub.get('command', first.id).executionId;
  loseAdmission = true;
  await engine.relay.refresh(); await engine.relay.refresh();
  assert.equal(service.hub.get('command', first.id).status, 'succeeded'); assert.equal(admissions, 1);
  assert.equal(service.hub.get('command', first.id).executionId, executionId);
  const second = await phone('send', { requestId: randomUUID(), sessionId: first.sessionId, prompt: 'Continue' });
  await engine.relay.refresh(); await engine.relay.refresh();
  assert.equal(service.hub.get('command', second.id).status, 'succeeded'); assert.equal(sessions.length, 1); assert.equal(admissions, 2);
  const stopped = await phone('send', { requestId: randomUUID(), sessionId: first.sessionId, prompt: 'Do not execute' });
  await phone('stop', { id: stopped.id }); await engine.relay.refresh(); assert.equal(admissions, 2);
  const nativeId = `session-${randomUUID()}`;
  sessions.push({ nativeId, cwd: root, title: 'Native UI fixture', state: 'idle', cursor: -1, readOnly: false });
  await engine.relay.refresh();
  const native = service.hub.all('session').find(s => s.nativeId === nativeId);
  assert(native); assert.notEqual(native.id, nativeId);
  const mapping = engine.store.value('native-session-ids', {});
  assert.equal(mapping[nativeId], native.id);
  const continued = await phone('send', { requestId: randomUUID(), sessionId: native.id, prompt: 'Continue native UI session' });
  await engine.relay.refresh(); await engine.relay.refresh();
  assert.equal(service.hub.get('command', continued.id).status, 'succeeded');
  assert.equal(sessions.filter(s => s.nativeId === nativeId).length, 1);
});
