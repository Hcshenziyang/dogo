import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createService } from '../src/server.ts';
import { config, env, fixture, provisionLogin } from './helpers.ts';

const input = (platform = 'mac') => ({ username: 'fixture-owner', password: 'Synthetic only password 731!', name: 'Fixture device', platform, installationId: randomUUID() });
const headers = (token: string) => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json' });

test('public registration is closed even for legacy desktop; local provisioning preserves migration identity', async t => {
  const { service, url, mac } = await fixture(t); const data = input();
  for (const token of ['', env.DOGO_MAC_TOKEN, env.DOGO_PHONE_TOKEN]) {
    for (const route of ['setup', 'register']) assert.equal((await fetch(url + '/v3/auth/' + route,
      { method: 'POST', headers: headers(token), body: JSON.stringify(data) })).status, 403);
  }
  const owner = await provisionLogin(service.account, data, service.account.authenticate(env.DOGO_MAC_TOKEN));
  assert.equal(owner.device, 'mac'); assert(owner.recoveryCode);
  await assert.rejects(service.account.provision({ username: data.username, password: data.password }), /already initialized/);
  assert.equal((await fetch(url + '/v3/auth/devices', { headers: headers(env.DOGO_PHONE_TOKEN) })).status, 403);
  assert.equal((await fetch(url + '/v3/auth/devices', { headers: headers(owner.token) })).status, 200);
  service.account.disableLegacy(service.account.authenticate(owner.token));
  await assert.rejects(mac.request('/v1/identity'), (error: any) => error.status === 401);
  const stored = JSON.stringify(service.store.db.prepare('SELECT * FROM account_user').all());
  assert(!stored.includes(data.password)); assert(!stored.includes(owner.recoveryCode));
});

test('fresh deployment provisions and logs in without any legacy devices or tokens', async t => {
  const service = createService({ database: ':memory:', port: 0 }, {});
  const url = await service.listen(); t.after(() => service.close());
  const data = { ...input(), password: 'test12345' };
  await service.account.provision({ username: data.username, password: data.password });
  const response = await fetch(url + '/v3/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });
  assert.equal(response.status, 200); const login = await response.json();
  assert.match(login.device, /^mac-/); assert.equal(service.account.devices(service.account.authenticate(login.token)).devices.length, 1);
  const again = await service.account.login(data, 'fresh', false); assert.equal(again.device, login.device);
  assert.equal((await fetch(url + '/v3/auth/status').then(r => r.json())).registrationEnabled, false);
});

test('new devices require explicit route grants, live revocation blocks old credentials and queued claims', async t => {
  const { service, url } = await fixture(t);
  const owner = await provisionLogin(service.account, input(), service.account.authenticate(env.DOGO_MAC_TOKEN));
  const login = await service.account.login(input('phone'), 'phone', false);
  const principal = service.account.authenticate(owner.token);
  assert.deepEqual(service.account.authenticate(login.token).device.publishTo, []);
  service.account.updateDevice(principal, { id: login.device, name: 'My test phone', memory: true, sendTo: ['mac'] });
  assert.deepEqual(service.account.authenticate(login.token).device.publishTo, ['/tasks/mac']);
  service.hub.execute(principal.device, 'advertise', { instance: randomUUID(), name: 'Fixture Mac', ready: true, projects: [] });
  const command = service.hub.execute(service.account.authenticate(login.token).device, 'create', {
    requestId: randomUUID(), target: 'mac', title: 'Queued before revocation', prompt: 'Synthetic test only',
  });
  const stream = await fetch(url + '/v1/events/stream', { headers: headers(login.token) });
  const reader = stream.body!.getReader(); await reader.read();
  service.account.revoke(principal, { id: login.device });
  assert.equal(service.hub.execute(principal.device, 'claim', { id: command.id, executionId: randomUUID() }).status, 'cancelled');
  assert.throws(() => service.account.authenticate(login.token), /revoked|invalid/);
  const ended = await Promise.race([(async () => {
    try { while (!(await reader.read()).done) { /* Drain already buffered pre-revocation events. */ } return true; } catch { return true; }
  })(), new Promise(resolve => setTimeout(() => resolve(false), 3000))]);
  assert.equal(ended, true, 'revocation closes existing SSE');
  assert.equal((await fetch(url + '/v1/identity', { headers: headers(login.token) })).status, 401);
});

test('same-origin browser cookie is HttpOnly, token never enters response, CSRF and cross-site requests are rejected', async t => {
  const service = createService({ ...config(), publicOrigin: 'https://dogo.test' }, env);
  const url = await service.listen(); t.after(() => service.close());
  await provisionLogin(service.account, input(), service.account.authenticate(env.DOGO_MAC_TOKEN));
  const response = await fetch(url + '/v3/auth/login', { method: 'POST', headers: { origin: 'https://dogo.test', 'content-type': 'application/json' }, body: JSON.stringify(input('web')) });
  assert.equal(response.status, 200); const value = await response.json(); assert.equal(value.token, undefined);
  const cookie = response.headers.get('set-cookie')!; assert.match(cookie, /HttpOnly/); assert.match(cookie, /SameSite=Strict/); assert.match(cookie, /Secure/);
  const base = { cookie: cookie.split(';')[0], origin: 'https://dogo.test', 'content-type': 'application/json' };
  assert.equal((await fetch(url + '/v3/auth/devices', { headers: base })).status, 200);
  assert.equal((await fetch(url + '/v3/auth/logout', { method: 'POST', headers: base })).status, 403);
  assert.equal((await fetch(url + '/v3/auth/devices', { headers: { ...base, origin: 'https://evil.test' } })).status, 403);
  assert.equal((await fetch(url + '/v3/auth/logout', { method: 'POST', headers: { ...base, 'x-dogo-csrf': value.csrf } })).status, 200);
  assert.equal((await fetch(url + '/v3/auth/devices', { headers: base })).status, 401);
});

test('recovery is single-use, invalidates all sessions and old pairing; idle sessions expire', async t => {
  const { service, setTime } = await fixture(t); const data = input();
  const owner = await provisionLogin(service.account, data, service.account.authenticate(env.DOGO_MAC_TOKEN));
  const replacement = await service.account.reset({ username: data.username, recoveryCode: owner.recoveryCode, password: 'Another synthetic password 829!' }, 'recover');
  assert(replacement.recoveryCode); assert.throws(() => service.account.authenticate(owner.token), /invalid/);
  assert.throws(() => service.account.authenticate(env.DOGO_MAC_TOKEN), /invalid/);
  await assert.rejects(service.account.reset({ username: data.username, recoveryCode: owner.recoveryCode, password: data.password }, 'recover'), /Invalid recovery/);
  const login = await service.account.login({ ...data, password: 'Another synthetic password 829!' }, 'login', false);
  setTime(100000 + 31 * 86400000);
  assert.throws(() => service.account.authenticate(login.token), /expired/);
});

test('brute force attempts are bounded and unknown accounts do not reveal account existence', async t => {
  const { service } = await fixture(t);
  await provisionLogin(service.account, input(), service.account.authenticate(env.DOGO_MAC_TOKEN));
  for (let n = 0; n < 8; n++) await assert.rejects(service.account.login({ ...input(), password: 'wrong' }, 'attacker', false), /Incorrect account or password/);
  await assert.rejects(service.account.login(input(), 'attacker', false), /Too many/);
});
