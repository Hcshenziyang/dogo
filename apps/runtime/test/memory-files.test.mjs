import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, symlink, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MemoryFiles } from '../src/memory-files.mjs';

test('dedicated memory editing uses content CAS, recoverable deletion, safe rename and export', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'dogo-memory-editor-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const files = new MemoryFiles(root);
  files.write('profile.md', 'base', null); files.write('profile.md', 'changed', 'base');
  assert.throws(() => files.write('profile.md', 'lost edit', 'base'), /已被其他/);
  files.rename('profile.md', 'personal/preferences.md', 'changed');
  assert.equal(files.read('profile.md'), null); assert.equal(files.read('personal/preferences.md'), 'changed');
  assert.deepEqual(files.export().files, { 'personal/preferences.md': 'changed' });
  assert.throws(() => files.write('../escape.md', 'bad', null));
  await symlink(path.join(root, 'personal/preferences.md'), path.join(root, 'linked.md'));
  assert.throws(() => files.read('linked.md'), /linked/);
  files.write('personal/preferences.md', null, 'changed');
  assert.equal(files.read('personal/preferences.md'), null);
  const backups = path.join(root, '.dogo-sync/backups');
  assert((await readdir(backups)).length >= 3);
  assert.equal(typeof JSON.parse(await readFile(path.join(backups, (await readdir(backups))[0]), 'utf8')).content, 'string');
});
