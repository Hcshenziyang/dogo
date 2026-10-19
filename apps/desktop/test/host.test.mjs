import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { writeFile } from 'node:fs/promises';
import { createService } from '../../others/services/src/server.ts';
import { config, env } from '../../others/services/test/helpers.ts';
import { DesktopHost } from '../src/host/client.mjs';
import { Store } from '../../../packages/dsh-plugin/src/host/store.mjs';
import { acquireData } from '../../../packages/dsh-plugin/src/host/data-lease.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'dogo-host-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
test('exclusive writer lease, consistent backup, and format compatibility protect existing state', async t => {
  const root = await fixture(t), store = new Store(root);
  store.setValue('instance', 'existing-device'); store.close();
  const release = await acquireData(root);
  await assert.rejects(acquireData(root), /已有 DogO/);
  assert((await readdir(root)).some(name => name.startsWith('pre-plugin-') && name.endsWith('.sqlite')));
  await release(); const again = await acquireData(root); await again();
  const reopened = new Store(root); assert.equal(reopened.value('instance'), 'existing-device'); reopened.close();
});
test('desktop launches one DSH host with real plugin services, authenticated APIs, native session continuation and clean restart', { timeout: 90000 }, async t => {
  const root = await fixture(t); let requests = 0;
  const server = http.createServer(async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk;
    const body = JSON.parse(text); if (body.tools?.length) requests++;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const [delta, finish_reason] of [[{ role: 'assistant', content: 'PLUGIN_HOST_OK' }, null], [{}, 'stop']]) res.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const store = new Store(root); store.configure({ ...store.settings(), model: 'fixture', endpoint: `http://127.0.0.1:${server.address().port}/v1` }); store.setValue('instance', 'preserved-instance'); store.close();
  // An installed pre-refactor profile does not declare the DogO Client plugin.
  const oldProfile = path.join(root, 'dsh/profiles/dogo');
  await mkdir(oldProfile, { recursive: true });
  await writeFile(path.join(oldProfile, 'package.json'), JSON.stringify({ name: 'dsh-profile-dogo', private: true,
    dependencies: { 'dsh-codex': '0.3.2', 'dsh-native-memory': '0.2.0' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-codex', 'dsh-native-memory'] } } }));
  await writeFile(path.join(oldProfile, 'cordis.patch.yml'), '- id: session-log-deepseek\n  config:\n    enabled: false\n');
  let host = new DesktopHost(root); t.after(() => host.close());
  await host.start();
  const bootstrap = await fetch(host.backend.webUrl, { redirect: 'manual' });
  const cookie = bootstrap.headers.getSetCookie().map(v => v.split(';')[0]).join('; ');
  assert(cookie, 'DSH bootstrap sets an operator session cookie');
  const browser = (method, params, origin = host.backend.url) => fetch(host.backend.url + '/dogo-client', {
    method: 'POST', headers: { cookie, origin, 'content-type': 'application/json' }, body: JSON.stringify({ method, params }),
  });
  assert.equal((await browser('snapshot')).status, 200);
  assert.equal((await browser('capabilitiesConfigure', { computer: true })).status, 403);
  assert.equal((await browser('remotePolicy', { autoExecute: true })).status, 403);
  assert.equal((await browser('snapshot', {}, 'https://evil.test')).status, 403);
  assert.equal((await browser('hubCache', { scope: 'https://old.test|mac', value: '{}' })).status, 400);
  const firstPid = host.backend.child.pid;
  const health = await host.backend.request('/host/health'); assert.equal(health.pid, firstPid); assert.equal(health.protocol, 1);
  assert.equal((await host.request('snapshot')).hub.instance, 'preserved-instance');
  assert.equal((await fetch(host.backend.url + '/dogo/host/health')).status, 403);
  assert.equal((await fetch(host.backend.url + '/dogo-client', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 401);
  assert.equal((await fetch(host.backend.url + '/dogo/host/rpc', { method: 'POST', headers: { authorization: 'Bearer ' + host.backend.token, Origin: 'https://evil.test' }, body: '{}' })).status, 403);
  await assert.rejects(host.call('capabilitiesConfigure', { computer: true }), /未知|不允许/);
  const sessionId = 'session-' + randomUUID(), requestId = randomUUID();
  const input = { sessionId, requestId, create: true, prompt: 'Synthetic fixture; do not call tools.' };
  await host.backend.request('/command', input);
  async function settled(id) {
    for (let n = 0; n < 200; n++) { const run = await host.backend.request('/command?id=' + id); if (run.status !== 'running') return run; await delay(50); }
    throw new Error('Native command did not complete');
  }
  assert.equal((await settled(requestId)).status, 'succeeded'); assert.equal(requests, 1);
  await host.backend.request('/command', input); assert.equal(requests, 1);
  await host.close();
  assert(!(await readdir(root)).includes('.dogo-host-lock'));
  // Simulate a user editing DSH settings after first import. Restart must preserve them.
  const profile = path.join(root, 'dsh/profiles/dogo/cordis.patch.yml');
  const userConfig = (await readFile(profile, 'utf8')) + '\n# user-managed DSH settings\n';
  await writeFile(profile, userConfig);
  host = new DesktopHost(root); await host.start();
  assert.equal(await readFile(profile, 'utf8'), userConfig); assert.notEqual(host.backend.child.pid, firstPid);
  assert.equal((await host.request('snapshot')).hub.instance, 'preserved-instance');
  await host.backend.request('/command', input); assert.equal(requests, 1);
  const nextId = randomUUID(); await host.backend.request('/command', { ...input, requestId: nextId, create: false, prompt: 'Continue same native session.' });
  assert.equal((await settled(nextId)).status, 'succeeded'); assert.equal(requests, 2);
  assert.equal((await host.backend.request('/sessions')).sessions.filter(s => s.nativeId === sessionId).length, 1);
});
test('unconfigured legacy model does not prevent native DSH host and personal memory APIs', { timeout: 60000 }, async t => {
  const root = await fixture(t), host = new DesktopHost(root); t.after(() => host.close());
  await host.start(); assert.equal((await host.request('snapshot')).settings.model, '');
  await host.request('memoryAction', { op: 'write', args: { path: 'preferences.md', content: 'Synthetic preference', base: null } });
  assert.equal((await host.request('memoryAction', { op: 'read', args: { path: 'preferences.md' } })).content, 'Synthetic preference');
  const state = await host.request('prepare', {}); assert(state.checks.find(c => c.id === 'dsh').ok);
  await host.close();
  assert.equal(await readFile(path.join(root, 'personal-memory/preferences.md'), 'utf8'), 'Synthetic preference');
});


test('real DSH Host plugin executes relay tasks, continues sessions, syncs memory and isolates logout', { timeout: 60000 }, async t => {
  const root = await fixture(t);
  const service = createService(config(path.join(root, 'relay.sqlite')), env), url = await service.listen();
  t.after(() => service.close());
  let modelCalls = 0;
  const model = http.createServer(async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk;
    if (JSON.parse(text).tools?.length) modelCalls++;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const [delta, finish_reason] of [[{ role: 'assistant', content: 'RELAY_PLUGIN_OK' }, null], [{}, 'stop']]) res.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  model.listen(0, '127.0.0.1'); await once(model, 'listening');
  t.after(() => { model.closeAllConnections(); model.close(); });
  const store = new Store(path.join(root, 'local'));
  store.configure({ ...store.settings(), model: 'fixture', endpoint: `http://127.0.0.1:${model.address().port}/v1` }); store.close();
  const host = new DesktopHost(path.join(root, 'local'), { env: {
    NODE_OPTIONS: '--import=' + new URL('./relay-transport-fixture.mjs', import.meta.url).href,
    DOGO_FIXTURE_ORIGIN: url,
  } });
  t.after(() => host.close()); await host.start();
  await host.request('connectRelay', { version: 1, device: 'mac', url: 'https://relay.fixture.invalid', token: env.DOGO_MAC_TOKEN });
  const phone = async (op, args) => {
    const response = await fetch(url + '/v2/hub', { method: 'POST', headers: { authorization: 'Bearer ' + env.DOGO_PHONE_TOKEN, 'content-type': 'application/json' }, body: JSON.stringify({ op, args }) });
    assert.equal(response.status, 200); return response.json();
  };
  const note = await phone('note', { requestId: randomUUID(), target: 'mac', title: 'Plugin note', text: 'Do not execute' });
  await host.request('refreshRelay');
  assert.equal(service.hub.get('note', note.id).state, 'received');
  assert.equal((await host.backend.request('/requests')).requests.length, 0);
  await host.request('remotePolicy', { autoExecute: true });
  const first = await phone('create', { requestId: randomUUID(), target: 'mac', title: 'Host task', prompt: 'Synthetic only; no tools.' });
  async function finished(id) {
    for (let i = 0; i < 80; i++) {
      await host.request('refreshRelay');
      const value = service.hub.get('command', id);
      if (value.status === 'succeeded') return value;
      if (value.status === 'failed') throw new Error(value.error || value.result);
      await delay(100);
    }
    throw new Error('Relay task did not finish');
  }
  await finished(first.id); assert.equal(modelCalls, 1);
  const second = await phone('send', { requestId: randomUUID(), sessionId: first.sessionId, prompt: 'Continue this same session.' });
  await finished(second.id); assert.equal(modelCalls, 2);
  assert.equal((await host.backend.request('/sessions')).sessions.length, 1);
  await host.request('memoryAction', { op: 'configure', args: { enabled: true } });
  await host.request('memoryAction', { op: 'write', args: { path: 'fixture.md', content: 'Plugin memory', base: null } });
  const sync = await host.request('memoryAction', { op: 'sync' }); assert.equal(sync.error, '');
  const memoryResponse = await fetch(url + '/v2/memory', { method: 'POST', headers: { authorization: 'Bearer ' + env.DOGO_PHONE_TOKEN, 'content-type': 'application/json' }, body: JSON.stringify({ op: 'list', args: {} }) });
  assert.equal(memoryResponse.status, 200); assert.match(JSON.stringify(await memoryResponse.json()), /fixture.md/);
  await host.request('hubCache', { scope: 'https://relay.fixture.invalid|mac', value: 'synthetic private cache' });
  assert.equal(await host.request('hubCache', { scope: 'https://relay.fixture.invalid|mac' }), 'synthetic private cache');
  await host.request('disconnectRelay');
  assert.equal(await host.request('hubCache', { scope: 'local' }), null);
  await assert.rejects(host.request('hubAction', { scope: 'https://relay.fixture.invalid|mac', op: 'snapshot', args: {} }), /身份已改变/);
  assert.equal((await host.request('snapshot')).relay.configured, false);
});
