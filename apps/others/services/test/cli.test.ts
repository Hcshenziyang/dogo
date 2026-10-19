import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, env, temp } from './helpers.ts';
import { ServiceClient } from '../src/client.ts';
import type { MemoryFile } from '../src/schema.ts';

test('real server and sync CLI entrypoints work with explicit temporary configuration', { timeout: 15_000 }, async t => {
  const root = temp();
  const configPath = join(root, 'config.json');
  const shared = join(root, 'shared'); mkdirSync(shared);
  writeFileSync(join(shared, 'memory.md'), 'CLI smoke test');
  writeFileSync(configPath, JSON.stringify(config('./service.sqlite')));
  const main = fileURLToPath(new URL('../src/main.ts', import.meta.url));
  const child = spawn(process.execPath, [main], { env: { ...process.env, ...env, DOGO_CONFIG: configPath }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const stopped = once(child, 'exit');
      child.kill('SIGTERM');
      await stopped;
    }
    rmSync(root, { recursive: true, force: true });
  });
  const url = await new Promise<string>((resolve, reject) => {
    let output = '';
    child.on('error', reject);
    child.once('exit', code => reject(new Error(`Server exited before ready (${code})`)));
    child.stdout.on('data', chunk => {
      output += chunk.toString();
      const match = /listening at (http:\/\/[^ ]+)/.exec(output);
      if (match) resolve(match[1]);
    });
  });
  const sync = fileURLToPath(new URL('../src/sync-cli.ts', import.meta.url));
  const command = spawn(process.execPath, [sync], { env: { ...process.env, DOGO_URL: url, DOGO_TOKEN: env.DOGO_MAC_TOKEN, DOGO_SHARED_DIR: shared }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  command.stdout.on('data', chunk => { stdout += chunk; });
  const [code] = await once(command, 'exit');
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(stdout).uploaded, ['memory.md']);
  const client = new ServiceClient(url, env.DOGO_PHONE_TOKEN);
  assert.equal((await client.request<MemoryFile>('/v1/memory/file?path=memory.md')).content, 'CLI smoke test');
});
