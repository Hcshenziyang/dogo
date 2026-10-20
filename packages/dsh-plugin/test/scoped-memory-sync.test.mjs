import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PersonalMemory } from '../src/host/memory.mjs';
import { createService } from '../../../apps/others/services/src/server.ts';
import { config, env } from '../../../apps/others/services/test/helpers.ts';

test('all four scopes sync through the real service, including CAS conflicts and deletion propagation', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'dogo-memory-sync-'));
  const service = createService(config(path.join(root, 'relay.sqlite')), env);
  const url = await service.listen();
  function device(id, token) {
    const settings = new Map();
    return new PersonalMemory({ directory: path.join(root, id),
      store: { value: (key, fallback) => settings.get(key) ?? fallback, setValue: (key, value) => settings.set(key, value), settings: () => ({}) },
      dsh: { native: true }, relay: { key: { url, device: id, token } }, hub: { policy: { autoExecute: false } }, changed() {},
    });
  }
  // A normal host creates its data directory before constructing memory.
  const { mkdir } = await import('node:fs/promises');
  await mkdir(path.join(root, 'mac')); await mkdir(path.join(root, 'phone'));
  const mac = device('mac', env.DOGO_MAC_TOKEN), phone = device('phone', env.DOGO_PHONE_TOKEN);
  t.after(async () => { await mac.close(); await phone.close(); await service.close(); await rm(root, { recursive: true, force: true }); });
  const created = [];
  for (const scope of ['personal', 'topic', 'project', 'session']) {
    const selector = { scope, ...(scope === 'personal' ? {} : { scopeId: `shared-${scope}` }) };
    created.push(await mac.recordAction({ action: 'create', ...selector, text: `${scope} cross-device fixture` },
      { sessionId: 'mac-session', seq: 7, callId: scope }));
  }
  await mac.sync(); assert.equal(mac.state.error, '');
  await phone.sync(); assert.equal(phone.state.error, '');
  for (const saved of created) {
    const selector = { scope: saved.record.scope, ...(saved.record.scopeId ? { scopeId: saved.record.scopeId } : {}), id: saved.record.id };
    assert.equal((await phone.recordAction({ action: 'read', ...selector })).record.text, saved.record.text);
  }
  const personal = created[0], origin = { sessionId: 'editing-session', seq: 9, callId: 'edit' };
  const selector = { scope: 'personal', id: personal.record.id };
  await mac.recordAction({ action: 'update', ...selector, version: personal.version, text: 'mac preference' }, origin); await mac.sync();
  await phone.recordAction({ action: 'update', ...selector, version: personal.version, text: 'phone preference' }, origin); await phone.sync();
  assert.equal(phone.state.error, '');
  assert(phone.state.conflicts.some(conflict => conflict.path === personal.path));
  assert.equal((await phone.recordAction({ action: 'read', ...selector })).record.text, 'phone preference');
  assert.equal((await mac.recordAction({ action: 'read', ...selector })).record.text, 'mac preference');
  const topic = created[1], topicSelector = { scope: 'topic', scopeId: 'shared-topic', id: topic.record.id };
  await mac.recordAction({ action: 'delete', ...topicSelector, version: topic.version }, origin); await mac.sync(); await phone.sync();
  await assert.rejects(phone.recordAction({ action: 'read', ...topicSelector }), /not found/);
  assert.equal((await phone.recordAction({ action: 'search', scope: 'project', scopeId: 'shared-project' })).total, 1);
  await mac.action({ op: 'write', args: { path: 'old-personal.md', base: null, content: 'Old duplicate fixture' } });
  await mac.sync(); await phone.sync();
  const legacy = (await phone.legacyFiles({ query: '', path: 'old-personal.md', offset: 0, limit: 1 })).files[0];
  await phone.forgetLegacyFile({ path: legacy.path, version: legacy.version });
  await phone.sync(); await mac.sync();
  assert.equal((await mac.action({ op: 'read', args: { path: legacy.path } })).content, null);
  assert.equal((await mac.recordAction({ action: 'read', ...selector })).record.text, 'mac preference');
});
