import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { receiveArtifacts } from '../src/artifacts.mjs';

test('desktop verifies attachment bytes before creating immutable task references and preserves local edits', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'dogo-artifacts-')); t.after(() => rm(root, { recursive: true, force: true }));
  const bytes = Buffer.from('SYNTHETIC_FILE_ONLY_827'), id = randomUUID();
  const meta = { id, name: 'fixture.txt', mime: 'text/plain', state: 'ready', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  const call = async (_op, args) => args.index === undefined ? meta : { data: bytes.toString('base64') };
  const [file] = await receiveArtifacts(root, [id], call); assert.equal(await readFile(file.path, 'utf8'), bytes.toString());
  assert.deepEqual(await receiveArtifacts(root, [id], call), [file]);
  await writeFile(file.path, 'local user edit');
  await assert.rejects(receiveArtifacts(root, [id], call), /本机附件已改变/);
  assert.equal(await readFile(file.path, 'utf8'), 'local user edit');
  const other = randomUUID();
  await assert.rejects(receiveArtifacts(root, [other], async (_op, args) => args.index === undefined ? { ...meta, id: other } : { data: 'eA==' }), /校验失败/);
  await assert.rejects(receiveArtifacts(root, [randomUUID()], call), /身份不匹配/);
});
