// Run against a temporary Rust server, test account and database; no personal data is used.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const temporary = await mkdtemp(join(tmpdir(), 'dogo-rename-integration-'));
const bundle = join(temporary, 'api.mjs');
let server;
try {
  await build({
    entryPoints: ['shared/api.ts'],
    outfile: bundle,
    bundle: true,
    platform: 'node',
    format: 'esm',
    banner: {
      js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
    },
  });
  const { Api } = await import(pathToFileURL(bundle));
  server = spawn(resolve('../server-rust/target/debug/dogo-memo-server'), [], {
    env: {
      ...process.env,
      DOGO_RUST_DATA_DIR: join(temporary, 'data'),
      DOGO_RUST_LISTEN: '127.0.0.1:0',
      DOGO_RUST_JWT_SECRET: 'synthetic-signing-secret-for-tests-only',
      DOGO_RUST_INVITE_CODE: 'synthetic-invite',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const address = await new Promise((resolveAddress, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(Error('Rust server startup timed out')), 15000);
    server.once('error', reject);
    server.once('exit', (code) => reject(Error('Rust server exited: ' + code)));
    server.stderr.on('data', (chunk) => {
      output += chunk.toString();
      const match = output.match(/DogO server listening on (127\.0\.0\.1:\d+)/);
      if (match) {
        clearTimeout(timer);
        resolveAddress('http://' + match[1]);
      }
    });
  });
  const post = async (path, body) =>
    fetch(address + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  const password = 'synthetic-password';
  let result = await post('/api/auth/register', {
    username: 'synthetic',
    password,
    invite_code: 'synthetic-invite',
  });
  assert.equal(result.status, 201);
  let record;
  const credentials = {
    async readRecord() {
      return record;
    },
    async modifyRecord(_key, update) {
      record = await update();
    },
    async deleteRecord() {
      record = undefined;
    },
  };
  const data = new Map();
  const store = {
    async read(key, fallback) {
      return data.get(key) ?? fallback;
    },
    async write(key, value) {
      data.set(key, value);
    },
  };
  const api = new Api(store, credentials, fetch);
  await api.login(address, 'synthetic', password, '我的电脑');
  const originalId = api.state.tokens.device_id;
  const oldAccess = api.state.tokens.access_token;
  result = await post('/api/auth/login', {
    username: 'synthetic',
    password,
    device_id: 'other-device',
    device_name: '我的电脑',
    device_kind: 'mobile',
  });
  assert.equal(result.status, 200);
  const other = await result.json();
  const list = async () => {
    const response = await fetch(address + '/api/devices', {
      headers: { Authorization: 'Bearer ' + other.access_token },
    });
    assert.equal(response.status, 200);
    return response.json();
  };
  await assert.rejects(api.renameDevice('书房电脑', 'wrong'), /账户密码不正确/);
  assert.equal((await list()).find((device) => device.id === originalId).name, '我的电脑');
  await api.renameDevice('书房电脑', password);
  const devices = await list();
  assert.equal(devices.length, 2);
  assert.equal(devices.find((device) => device.id === originalId).name, '书房电脑');
  assert.equal(devices.find((device) => device.id === 'other-device').name, '我的电脑');
  assert.equal(api.state.tokens.device_id, originalId);
  assert.equal(
    (await fetch(address + '/api/auth/me', { headers: { Authorization: 'Bearer ' + oldAccess } }))
      .status,
    401,
  );
  assert.equal((await api.request('/api/auth/me')).username, 'synthetic');
  console.log(
    'PASS: Rust server rename, same device identity, password rejection and second-device view',
  );
} finally {
  if (server && server.exitCode === null) {
    server.kill('SIGTERM');
    await new Promise((resolveExit) => server.once('exit', resolveExit));
  }
  await rm(temporary, { recursive: true, force: true });
}
