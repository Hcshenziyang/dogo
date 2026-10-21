import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createService } from '../src/server.ts';
import { config, env, temp, provisionLogin } from './helpers.ts';
import { BrowserHub } from '../../../../packages/hub-ui/src/browser.ts';

test('default browser transport preserves the native fetch receiver', async t => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  let calls = 0;
  globalThis.fetch = async function () { assert.equal(this, globalThis); calls++; return Response.json({ authenticated: true, device: 'web-fixture', csrf: 'fixture' }); };
  const client = new BrowserHub('https://fixture.test', { getItem: () => null, setItem() {}, removeItem() {} });
  assert.equal((await client.status()).device, 'web-fixture'); assert.equal(calls, 1);
});

test('real browser transport uses cookie and CSRF; all account and Hub flows keep bearer secrets out of web storage', async t => {
  const service = createService({ ...config(), publicOrigin: 'https://fixture.test' }, env);
  const local = await service.listen(); t.after(() => service.close());
  const credentials = { username: 'fixture-owner', password: 'Synthetic password only 731!', name: 'Fixture Web' };
  const owner = await provisionLogin(service.account, { ...credentials, platform: 'mac', installationId: randomUUID() }, service.account.authenticate(env.DOGO_MAC_TOKEN));
  const values = new Map<string, string>(); let cookie = '';
  const browser = new BrowserHub('https://fixture.test', { getItem: k => values.get(k) ?? null, setItem: (k, v) => { values.set(k, v); }, removeItem: k => { values.delete(k); } }, async (url, options) => {
    const headers = new Headers(options?.headers);
    assert(!headers.has('authorization'));
    if (cookie) headers.set('cookie', cookie);
    if (options?.method === 'POST') headers.set('origin', 'https://fixture.test'); // Browser-managed header.
    const result = await fetch(String(url).replace('https://fixture.test', local), { ...options, headers });
    if (result.headers.has('set-cookie')) cookie = result.headers.get('set-cookie')!.split(';')[0];
    return result;
  });
  assert.equal((await browser.status()).configured, false);
  const login = await browser.account({ op: 'login', args: credentials }); assert.equal(login.token, undefined);
  assert.equal((await browser.status()).device, login.device);
  assert(!JSON.stringify([...values]).includes(cookie.split('=')[1]));
  assert(!JSON.stringify([...values]).includes(credentials.password));
  await browser.account({ op: 'device', args: { id: login.device, name: 'Fixture Web', memory: true, sendTo: ['mac'] } });
  service.hub.execute(service.account.authenticate(owner.token).device, 'advertise', { instance: randomUUID(), name: 'Fixture Mac', ready: true, projects: [] });
  const task = await browser.hub({ origin: 'https://fixture.test', op: 'create', args: { requestId: randomUUID(), target: 'mac', title: 'Browser task', prompt: 'Synthetic only' } });
  assert.equal(task.status, 'queued');
  await assert.rejects(browser.hub({ origin: 'https://other.test', op: 'snapshot', args: {} }));
  await browser.account({ op: 'logout' }); assert.equal((await browser.status()).configured, false);
  assert.equal(values.has('dogo.web.identity'), false);
});

test('web hosting exposes only built assets, blocks symlink escapes and sets a restrictive CSP', async t => {
  const root = temp(), web = join(root, 'web'); mkdirSync(join(web, 'assets'), { recursive: true });
  writeFileSync(join(web, 'index.html'), '<!doctype html><title>Fixture</title>');
  writeFileSync(join(web, 'assets/main-1.js'), '/* synthetic */');
  writeFileSync(join(root, 'private.txt'), 'MUST_NOT_LEAK');
  symlinkSync(join(root, 'private.txt'), join(web, 'assets/escape.js'));
  const service = createService({ ...config(), publicOrigin: 'https://fixture.test', webRoot: web }, env);
  const url = await service.listen(); t.after(async () => { await service.close(); rmSync(root, { recursive: true, force: true }); });
  const page = await fetch(url + '/'); assert.equal(page.status, 200); assert.match(page.headers.get('content-security-policy')!, /frame-ancestors 'none'/);
  assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
  assert.equal((await fetch(url + '/assets/main-1.js')).status, 200);
  for (const path of ['/private.txt', '/assets/escape.js', '/assets/main-1.js.map', '/assets/%2e%2e/private.txt']) {
    const response = await fetch(url + path); assert.notEqual(response.status, 200); assert(!(await response.text()).includes('MUST_NOT_LEAK'));
  }
});
