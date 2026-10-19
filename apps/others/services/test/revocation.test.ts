import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture } from './helpers.ts';

test('route and project revocation cancel queued work and request stop of accepted work, never native local turns', async t => {
  const { service } = await fixture(t), hub = service.hub;
  const mac = service.store.config.devices.find(d => d.id === 'mac')!, phone = service.store.config.devices.find(d => d.id === 'phone')!;
  const instance = randomUUID(), projectId = randomUUID();
  const advertise = (allowed: boolean) => hub.execute(mac, 'advertise', { instance, name: 'Fixture', ready: true, projects: [{ id: projectId, name: 'project', summary: '', available: allowed, published: true, executionAllowed: allowed }] });
  advertise(true);
  const make = () => hub.execute(phone, 'create', { requestId: randomUUID(), target: 'mac', projectId, title: 'fixture', prompt: 'synthetic' });
  const first = make(), second = make();
  const running = first, queued = second;
  hub.execute(mac, 'claim', { id: running.id, executionId: randomUUID() });
  advertise(false); hub.execute(mac, 'snapshot', {});
  assert.equal(hub.get('command', queued.id).status, 'cancelled'); assert(hub.get('command', running.id).stopRequested); assert.equal(hub.get('command', running.id).status, 'running');
  advertise(true);
  const queuedRoute = make();
  phone.publishTo = []; hub.execute(mac, 'snapshot', {}); assert.equal(hub.get('command', queuedRoute.id).status, 'cancelled');
  const localId = randomUUID(); hub.execute(mac, 'observe', { id: localId, sessionId: first.sessionId, prompt: 'native', result: '', status: 'running', truncated: false, revision: 1, createdAt: Date.now() });
  hub.execute(mac, 'snapshot', {}); assert.equal(hub.get('command', localId).stopRequested, false);
});
