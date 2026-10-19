import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { syncFolder } from '../src/sync.ts';
import type { MemoryFile } from '../src/schema.ts';
import { fixture } from './helpers.ts';

test('folder sync uploads/downloads and propagates edits/deletions with backups; project memory is untouched', async t => {
  const f = await fixture(t);
  const a = join(f.root, 'mac-shared'), b = join(f.root, 'phone-shared'), project = join(f.root, 'project-local');
  for (const folder of [a, b, project]) mkdirSync(folder);
  writeFileSync(join(a, 'preferences.md'), 'Prefer concise answers.');
  writeFileSync(join(project, 'private.md'), 'LOCAL ONLY');
  writeFileSync(join(a, '.env'), 'DO_NOT_SYNC');
  assert.deepEqual((await syncFolder(f.mac, a)).uploaded, ['preferences.md']);
  assert.deepEqual((await syncFolder(f.phone, b)).downloaded, ['preferences.md']);
  assert.equal(readFileSync(join(b, 'preferences.md'), 'utf8'), 'Prefer concise answers.');
  const manifest = await f.phone.request<{ files: { path: string }[] }>('/v1/memory');
  assert.deepEqual(manifest.files.map(file => file.path), ['preferences.md']);
  writeFileSync(join(b, 'preferences.md'), 'Updated by phone');
  await syncFolder(f.phone, b);
  await syncFolder(f.mac, a);
  assert.equal(readFileSync(join(a, 'preferences.md'), 'utf8'), 'Updated by phone');
  assert.equal(readdirSync(join(a, '.dogo-sync', 'backups')).length, 1);
  unlinkSync(join(a, 'preferences.md'));
  await syncFolder(f.mac, a);
  assert.deepEqual((await syncFolder(f.phone, b)).deleted, ['preferences.md']);
  assert.equal(existsSync(join(b, 'preferences.md')), false);
  assert.equal(readdirSync(join(b, '.dogo-sync', 'backups')).length, 1);
  assert.equal(readFileSync(join(project, 'private.md'), 'utf8'), 'LOCAL ONLY');
});

test('offline simultaneous edits conflict without overwriting either copy', async t => {
  const f = await fixture(t);
  const a = join(f.root, 'a'), b = join(f.root, 'b');
  mkdirSync(a); mkdirSync(b);
  writeFileSync(join(a, 'memory.md'), 'base');
  await syncFolder(f.mac, a); await syncFolder(f.phone, b);
  writeFileSync(join(a, 'memory.md'), 'mac offline change');
  writeFileSync(join(b, 'memory.md'), 'phone change');
  await syncFolder(f.phone, b);
  assert.deepEqual((await syncFolder(f.mac, a)).conflicts, ['memory.md']);
  assert.equal(readFileSync(join(a, 'memory.md'), 'utf8'), 'mac offline change');
  const remote = await f.mac.request<MemoryFile>('/v1/memory/file?path=memory.md');
  assert.equal(remote.content, 'phone change');
  // Explicit reconciliation: matching contents clears the conflict on the next pass.
  writeFileSync(join(a, 'memory.md'), remote.content!);
  assert.deepEqual((await syncFolder(f.mac, a)).conflicts, []);
});

test('memory compare-and-swap rejects stale edits and safely retries lost responses', async t => {
  const { mac, phone } = await fixture(t);
  const input = { path: 'memory.md', baseVersion: 0, content: 'first' };
  const first = await mac.request<MemoryFile>('/v1/memory/file', 'PUT', input);
  assert.equal((await mac.request<MemoryFile>('/v1/memory/file', 'PUT', input)).version, first.version);
  await assert.rejects(phone.request('/v1/memory/file', 'PUT', { ...input, content: 'other' }), /conflict/);
  await assert.rejects(mac.request('/v1/memory/file', 'PUT', { ...input, path: '../../secret.md' }), /Invalid request/);
  await mac.request('/v1/memory/file', 'PUT', { ...input, baseVersion: 1, content: null });
  await assert.rejects(phone.request('/v1/memory/file', 'PUT', { ...input, baseVersion: 1, content: 'resurrect' }), /conflict/);
});

test('offline failures preserve local files; later sync uploads them', async t => {
  const f = await fixture(t);
  const a = join(f.root, 'shared'); mkdirSync(a);
  writeFileSync(join(a, 'memory.md'), 'local pending');
  const original = f.mac.request.bind(f.mac);
  f.mac.request = async () => { throw new Error('offline'); };
  await assert.rejects(syncFolder(f.mac, a), /offline/);
  assert.equal(readFileSync(join(a, 'memory.md'), 'utf8'), 'local pending');
  assert.equal(existsSync(join(a, '.dogo-sync', 'lock')), false);
  f.mac.request = original;
  assert.deepEqual((await syncFolder(f.mac, a)).uploaded, ['memory.md']);
});

test('server rollback is a conflict, not an instruction to delete local memory', async t => {
  const f = await fixture(t);
  const a = join(f.root, 'shared'); mkdirSync(a);
  writeFileSync(join(a, 'memory.md'), 'keep me');
  await syncFolder(f.mac, a);
  f.service.store.db.exec('DELETE FROM memory');
  assert.deepEqual((await syncFolder(f.mac, a)).conflicts, ['memory.md']);
  assert.equal(readFileSync(join(a, 'memory.md'), 'utf8'), 'keep me');
});

test('a folder cannot accidentally reuse another device sync baseline', async t => {
  const f = await fixture(t);
  const a = join(f.root, 'shared'); mkdirSync(a);
  writeFileSync(join(a, 'memory.md'), 'hello');
  await syncFolder(f.mac, a);
  await assert.rejects(syncFolder(f.phone, a), /different server\/device/);
});

test('symlinks and overlapping sync runs are rejected', async t => {
  const f = await fixture(t);
  const a = join(f.root, 'shared'); mkdirSync(a);
  mkdirSync(join(a, '.dogo-sync'));
  writeFileSync(join(a, '.dogo-sync', 'lock'), '');
  await assert.rejects(syncFolder(f.mac, a), /EEXIST/);
  unlinkSync(join(a, '.dogo-sync', 'lock'));
  const outside = join(f.root, 'outside'); mkdirSync(outside);
  writeFileSync(join(outside, 'secret.md'), 'never upload');
  symlinkSync(outside, join(a, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(syncFolder(f.mac, a), /Symlinks/);
});

test('nested shared folders sync using portable relative paths', async t => {
  const f = await fixture(t);
  const a = join(f.root, 'shared'); mkdirSync(a);
  await f.phone.request('/v1/memory/file', 'PUT', { path: 'personal/preferences.md', baseVersion: 0, content: 'nested' });
  assert.deepEqual((await syncFolder(f.mac, a)).downloaded, ['personal/preferences.md']);
  assert.equal(readFileSync(join(a, 'personal', 'preferences.md'), 'utf8'), 'nested');
});

test('dead-process sync locks recover, but a live-process lock remains protected', async t => {
  const f = await fixture(t);
  const folder = join(f.root, 'locked-memory');
  mkdirSync(join(folder, '.dogo-sync'), { recursive: true });
  const lock = join(folder, '.dogo-sync', 'lock');
  writeFileSync(lock, JSON.stringify({ pid: process.pid }));
  await assert.rejects(syncFolder(f.mac, folder), /EEXIST/);
  // A very high PID is checked by the OS first, never assumed to be absent.
  const deadPid = 2147483647;
  assert.throws(() => process.kill(deadPid, 0), { code: 'ESRCH' });
  writeFileSync(lock, JSON.stringify({ pid: deadPid }));
  await syncFolder(f.mac, folder);
  assert.equal(existsSync(lock), false);
});

test('upload committed but response lost is reconciled without creating a second version', async t => {
  const f = await fixture(t);
  const a = join(f.root, 'shared'); mkdirSync(a);
  writeFileSync(join(a, 'memory.md'), 'pending');
  const request = f.mac.request.bind(f.mac);
  let loseResponse = true;
  f.mac.request = async <T>(path: string, method = 'GET', input?: unknown): Promise<T> => {
    const result = await request<T>(path, method, input);
    if (method === 'PUT' && loseResponse) { loseResponse = false; throw new Error('response lost'); }
    return result;
  };
  await assert.rejects(syncFolder(f.mac, a), /response lost/);
  assert.deepEqual((await syncFolder(f.mac, a)).conflicts, []);
  assert.equal((await request<MemoryFile>('/v1/memory/file?path=memory.md')).version, 1);
});

test('local edit during a download is preserved and reported as a conflict', async t => {
  const f = await fixture(t);
  const a = join(f.root, 'shared'); mkdirSync(a);
  await f.phone.request('/v1/memory/file', 'PUT', { path: 'memory.md', baseVersion: 0, content: 'remote' });
  const request = f.mac.request.bind(f.mac);
  f.mac.request = async <T>(path: string, method = 'GET', input?: unknown): Promise<T> => {
    const result = await request<T>(path, method, input);
    if (path.startsWith('/v1/memory/file?')) writeFileSync(join(a, 'memory.md'), 'edited during network wait');
    return result;
  };
  assert.deepEqual((await syncFolder(f.mac, a)).conflicts, ['memory.md']);
  assert.equal(readFileSync(join(a, 'memory.md'), 'utf8'), 'edited during network wait');
});

test('revoking memory permission also hides old memory notifications', async t => {
  const f = await fixture(t);
  await f.mac.request('/v1/memory/file', 'PUT', { path: 'memory.md', baseVersion: 0, content: 'shared' });
  const phone = f.service.config.devices.find(d => d.id === 'phone')!;
  assert.equal(f.service.store.events(phone, 0).length, 1);
  phone.memory = false;
  assert.equal(f.service.store.events(phone, 0).length, 0);
  await assert.rejects(f.phone.request('/v1/memory/file?path=memory.md'), /not allowed/);
});
