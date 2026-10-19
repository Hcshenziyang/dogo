import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture } from './helpers.ts';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { syncFolder } from '../src/sync.ts';

test('personal memory retains base/both edits, bounds Agent attempts, resolves transactionally and synchronizes merge', async t => {
  const { root, mac, phone, win } = await fixture(t);
  const folder = join(root, 'personal'); await mkdir(folder);
  const local = join(folder, 'preferences.md'); await writeFile(local, 'base');
  await syncFolder(mac, folder);
  const call = (op: string, args = {}) => mac.request<any>('/v2/memory', 'POST', { op, args });
  await phone.request('/v2/memory', 'POST', { op: 'write', args: { path: 'preferences.md', baseVersion: 1, content: 'phone change' } });
  await writeFile(local, 'mac change');
  let conflict: any;
  const report = await syncFolder(mac, folder, async ({ remoteVersion: _, ...input }) => { conflict = (await call('conflict', input)).conflict; return null; });
  assert.deepEqual(report.conflicts, ['preferences.md']);
  assert.equal(conflict.base, 'base'); assert.equal(conflict.remote, 'phone change'); assert.equal(conflict.local, 'mac change');
  assert.equal(await readFile(local, 'utf8'), 'mac change');
  const executionId = randomUUID();
  await call('claim', { id: conflict.id, executionId });
  await assert.rejects(call('claim', { id: conflict.id, executionId: randomUUID() }), /already claimed/);
  const resolved = await call('resolve', { id: conflict.id, executionId, version: 2, content: 'combined', reason: 'Synthetic merge' });
  assert.equal(resolved.resolutionVersion, 3);
  await syncFolder(mac, folder, async () => ({ content: resolved.resolution, version: resolved.resolutionVersion }));
  assert.equal(await readFile(local, 'utf8'), 'combined');
  assert.equal((await call('versions', { path: 'preferences.md' })).versions.length, 3);
  await assert.rejects(win.request('/v2/memory', 'POST', { op: 'conflicts', args: {} }), /not allowed/);
});

test('stale merge cannot overwrite newer memory; interrupted analysis requires human instead of replay', async t => {
  const { mac } = await fixture(t);
  const call = (op: string, args = {}) => mac.request<any>('/v2/memory', 'POST', { op, args });
  await call('write', { path: 'profile.md', baseVersion: 0, content: 'one' });
  const { conflict } = await call('conflict', { path: 'profile.md', baseVersion: 0, local: 'other' });
  const executionId = randomUUID(); await call('claim', { id: conflict.id, executionId });
  await call('write', { path: 'profile.md', baseVersion: 1, content: 'newer' });
  await assert.rejects(call('resolve', { id: conflict.id, executionId, version: 1, content: 'stale', reason: 'test' }), /changed while merging/);
  await call('defer', { id: conflict.id, executionId, reason: 'Interrupted' });
  await assert.rejects(call('claim', { id: conflict.id, executionId: randomUUID() }), /already claimed/);
  assert.equal((await call('read', { path: 'profile.md' })).file.content, 'newer');
});
