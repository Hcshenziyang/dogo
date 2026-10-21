import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, statSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { temp } from './helpers.ts';
import { createService } from '../src/server.ts';

test('local provisioning CLI needs no tokens, keeps secrets out of output and refuses replacement', async t => {
  const root = temp(); t.after(() => rmSync(root, { recursive: true, force: true }));
  const config = { database: join(root, 'account.sqlite'), port: 0 };
  const configPath = join(root, 'config.json'), recovery = join(root, 'recovery.json');
  writeFileSync(configPath, JSON.stringify(config));
  const input = { username: 'fixture-owner', password: 'test12345' };
  const command = fileURLToPath(new URL('../src/provision-account.ts', import.meta.url));
  const run = (file: string) => spawnSync(process.execPath, [command, file], {
    env: { ...process.env, DOGO_CONFIG: configPath }, input: JSON.stringify(input), encoding: 'utf8',
  });
  const result = run(recovery); assert.equal(result.status, 0, result.stderr);
  const saved = JSON.parse(readFileSync(recovery, 'utf8'));
  assert(saved.recoveryCode); assert(!result.stdout.includes(saved.recoveryCode)); assert(!result.stdout.includes(input.password));
  assert.equal(statSync(recovery).mode & 0o777, 0o600);
  assert.notEqual(run(join(root, 'duplicate.json')).status, 0);
  const service = createService(config, {}); t.after(() => service.store.db.close());
  const login = await service.account.login({ ...input, name: 'Fresh Mac', platform: 'mac', installationId: crypto.randomUUID() }, 'test', false);
  assert.match(login.device, /^mac-/);
});
