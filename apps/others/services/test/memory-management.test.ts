import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture } from './helpers.ts';

test('rename and restore retain versions; maintenance primary/backup and revocation are enforced', async t => {
  const { mac, phone } = await fixture(t);
  const call = (op: string, args = {}) => mac.request<any>('/v2/memory', 'POST', { op, args });
  const other = (op: string, args = {}) => phone.request<any>('/v2/memory', 'POST', { op, args });
  await call('write', { path: 'one.md', baseVersion: 0, content: 'first' });
  await assert.rejects(call('rename', { path: 'one.md', target: 'two.md', baseVersion: 0 }), /changed/);
  await call('rename', { path: 'one.md', target: 'two.md', baseVersion: 1 });
  assert.equal((await call('read', { path: 'one.md' })).file.content, null);
  assert.equal((await call('read', { path: 'two.md' })).file.content, 'first');
  await call('restore', { path: 'one.md', version: 1, baseVersion: 2 });
  assert.equal((await call('read', { path: 'one.md' })).file.version, 3);
  assert.equal((await call('restore', { path: 'one.md', version: 1, baseVersion: 2 })).file.version, 3); // Lost-response retry is idempotent.
  const { conflict } = await call('conflict', { path: 'one.md', baseVersion: 1, local: 'different' });
  await call('configurePolicy', { primary: 'mac', backup: 'phone', automatic: true });
  await mac.request('/v1/heartbeat', 'POST', {});
  assert.equal((await other('policy')).canMaintain, false);
  await assert.rejects(other('claim', { id: conflict.id, executionId: randomUUID() }), /configured maintenance/);
  await mac.request('/v2/hub', 'POST', { op: 'offline', args: {} });
  const executionId = randomUUID(); await other('claim', { id: conflict.id, executionId });
  await call('configurePolicy', { primary: 'mac', backup: 'phone', automatic: false });
  await assert.rejects(other('resolve', { id: conflict.id, executionId, version: 3, content: 'merged', reason: 'fixture' }), /permission has changed/);
  await other('defer', { id: conflict.id, executionId, reason: 'policy changed' });
  assert.equal((await call('conflicts')).conflicts[0].status, 'needs-human');
});

test('version history is paged without dropping older contents', async t => {
  const { mac } = await fixture(t);
  const call = (op: string, args = {}) => mac.request<any>('/v2/memory', 'POST', { op, args });
  for (let i = 0; i < 23; i++) await call('write', { path: 'history.md', baseVersion: i, content: `version-${i + 1}` });
  const first = await call('versions', { path: 'history.md' });
  assert.equal(first.versions.length, 10); assert.equal(first.versions[0].version, 23);
  const second = await call('versions', { path: 'history.md', before: first.nextBefore });
  const last = await call('versions', { path: 'history.md', before: second.nextBefore });
  assert.equal(last.nextBefore, null);
  const all = [...first.versions, ...second.versions, ...last.versions];
  assert.equal(new Set(all.map(v => v.version)).size, 23);
  assert.equal(all.at(-1).content, 'version-1');
  await call('restore', { path: 'history.md', version: 1, baseVersion: 23 });
  assert.equal((await call('read', { path: 'history.md' })).file.content, 'version-1');
});
