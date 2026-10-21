import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DesktopAccount } from '../src/account.mjs';
import { fixture, env } from '../../others/services/test/helpers.ts';

const owner = { username: 'fixture-owner', password: 'Synthetic password only 731!', name: 'Fixture Mac' };
async function desktop(t, overrides = {}) {
  const backend = await fixture(t); const events = [];
  let key = { version: 1, url: 'https://fixture.test', device: 'mac', token: env.DOGO_MAC_TOKEN };
  const account = new DesktopAccount({ platform: 'mac', installationId: randomUUID(), read: () => key,
    save: value => { events.push('save'); key = value; }, clear: () => { events.push('clear'); key = undefined; },
    connect: async () => { events.push('connect'); }, disconnect: async () => { events.push('disconnect'); },
    fetcher: (url, options) => fetch(url.replace('https://fixture.test', backend.url), options), ...overrides });
  return { ...backend, account, events, key: () => key };
}
test('desktop migrates original identity, saves before connect, and never exposes session token through IPC', async t => {
  const f = await desktop(t);
  assert.equal((await f.account.execute({ op: 'status' })).canSetup, false);
  await assert.rejects(f.account.execute({ op: 'setup', args: owner }), /无效账号操作/);
  await f.service.account.provision({ username: owner.username, password: owner.password });
  const setup = await f.account.execute({ op: 'login', args: owner });
  assert.equal(setup.device, 'mac'); assert.equal(setup.recoveryCode, undefined); assert.equal(setup.token, undefined); assert.equal(setup.csrf, undefined);
  assert.deepEqual(f.events, ['save', 'connect']); assert.equal(f.key().version, 2);
  assert.equal((await f.account.execute({ op: 'status' })).authenticated, true);
  assert.equal((await f.account.execute({ op: 'devices' })).devices.length, 3);
  await f.account.execute({ op: 'disable-legacy' });
  assert.throws(() => f.service.account.authenticate(env.DOGO_MAC_TOKEN));
  const token = f.key().token;
  await f.account.execute({ op: 'logout' });
  assert.equal(f.key(), undefined); assert.deepEqual(f.events.slice(-2), ['disconnect', 'clear']);
  assert.throws(() => f.service.account.authenticate(token));
  const login = await f.account.execute({ op: 'login', url: 'https://fixture.test', args: owner });
  assert.equal(login.device, 'mac', 'installation ID survives login without the old file');
});
test('desktop never sends an existing credential to a different origin and refuses unknown IPC operations', async t => {
  const seen = [];
  const f = await desktop(t, { fetcher: async (url, options) => { seen.push({ url, options }); return Response.json({ initialized: true }); } });
  await f.account.execute({ op: 'status', url: 'https://other.test' });
  assert.equal(seen.length, 1); assert.equal(seen[0].options.headers.Authorization, undefined);
  for (const value of [{ op: 'shell' }, { op: 'status', token: 'bad' }, { op: 'status', url: 'http://other.test' }, { op: 'status', url: 'https://x.test/path' }])
    await assert.rejects(f.account.execute(value));
});
test('offline native logout clears only credentials, reports remote revocation unconfirmed, and serializes password operations', async t => {
  const f = await desktop(t);
  await f.service.account.provision({ username: owner.username, password: owner.password });
  await f.account.execute({ op: 'login', args: owner });
  f.account.fetcher = async () => { throw new Error('offline'); };
  const result = await f.account.execute({ op: 'logout' });
  assert.match(result.warning, /服务端未确认/); assert.equal(f.key(), undefined);
  let release; f.account.fetcher = async () => { await new Promise(resolve => { release = resolve; }); return Response.json({ initialized: true }); };
  const pending = f.account.execute({ op: 'status', url: 'https://fixture.test' });
  await assert.rejects(f.account.execute({ op: 'status', url: 'https://fixture.test' }), /正在进行/);
  release(); await pending;
});

test('fresh desktop signs in without pairing and remembers service origin after logout', async t => {
  let key, origin = '';
  const f = await desktop(t, { read: () => key, save: value => { key = value; }, clear: () => { key = undefined; },
    readOrigin: () => origin, saveOrigin: value => { origin = value; } });
  await f.service.account.provision({ username: owner.username, password: owner.password });
  const signedIn = await f.account.execute({ op: 'login', url: 'https://fixture.test', args: owner });
  assert.match(signedIn.device, /^mac-/); assert.equal(signedIn.token, undefined);
  const id = signedIn.device;
  await f.account.execute({ op: 'logout' });
  assert.equal(key, undefined);
  const status = await f.account.execute({ op: 'status' });
  assert.equal(status.url, 'https://fixture.test'); assert.equal(status.authenticated, false);
  assert.equal((await f.account.execute({ op: 'login', args: owner })).device, id);
});
