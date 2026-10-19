import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Engine } from '../src/engine.mjs';
import { Relay, pairingSchema } from '../src/relay.mjs';
import { createService } from '../../others/services/src/server.ts';

async function fixture(t) {
  const folder = await mkdtemp(path.join(tmpdir(), 'dogo-relay-test-'));
  const config = { database: path.join(folder, 'relay.sqlite'), port: 0, services: ['tasks'],
    devices: [{ id: 'mac', tokenEnv: 'MAC', publishTo: [] }, { id: 'phone', tokenEnv: 'PHONE', publishTo: ['/tasks/mac'] }],
    mailboxes: { '/tasks/mac': 'mac' } };
  const token = 'm'.repeat(43), phone = 'p'.repeat(43);
  const service = createService(config, { MAC: token, PHONE: phone });
  const address = await service.listen();
  const engine = new Engine(path.join(folder, 'desktop'));
  const folderForTask = path.join(folder, 'fixture'); await mkdir(folderForTask); await writeFile(path.join(folderForTask, 'hello.ts'), 'export const hello = 1;');
  engine.relay = new Relay(engine, (url, opts) => fetch(url.replace('https://relay.example', address), opts));
  const pairing = { version: 1, url: 'https://relay.example', device: 'mac', token };
  const remote = service.store.create(config.devices[1], { requestId: randomUUID(), mailbox: '/tasks/mac', title: 'Test', instructions: 'List test fixture files only' });
  t.after(async () => { await engine.close(); await service.close(); await rm(folder, { recursive: true, force: true }); });
  return { engine, service, remote, pairing, folderForTask, address };
}
test('remote tasks wait for explicit local acceptance, then real directory results are returned idempotently', async t => {
  const { engine, service, remote, pairing, folderForTask } = await fixture(t);
  await engine.relay.connect(pairing);
  assert.equal(engine.snapshot().relay.inbox.length, 1);
  assert.equal(engine.store.tasks().length, 0);
  await assert.rejects(engine.relay.accept({ id: remote.id, kind: 'inspect' }), /选择/);
  assert.equal(service.store.readTask(remote.id).status, 'queued');
  const grant = await engine.authorizeWorkspace(folderForTask);
  const id = await engine.relay.accept({ id: remote.id, kind: 'inspect', workspaceId: grant.id });
  await engine.active.get(id)?.done;
  await engine.relay.refresh();
  assert.equal(service.store.readTask(remote.id).status, 'succeeded');
  assert.match(service.store.readTask(remote.id).result, /hello.ts/);
  await assert.rejects(engine.relay.accept({ id: remote.id, kind: 'inspect', workspaceId: grant.id }), /重复/);
  assert.equal(engine.store.tasks().length, 1);
  assert.equal(engine.store.relayJobs()[0].returned, true);
  assert.equal(engine.snapshot().relay.deliveries[0].returned, true);
  assert.doesNotMatch(JSON.stringify(engine.snapshot()), new RegExp(pairing.token));
});
test('lost claim response retries the same durable execution identity without duplicate work', async t => {
  const { engine, service, remote, pairing, folderForTask, address } = await fixture(t);
  let lose = true;
  engine.relay.fetcher = async (url, opts) => {
    const response = await fetch(url.replace('https://relay.example', address), opts);
    if (url.endsWith('/claim') && lose) { lose = false; throw new Error('lost response'); }
    return response;
  };
  await engine.relay.connect(pairing);
  const grant = await engine.authorizeWorkspace(folderForTask);
  const input = { id: remote.id, kind: 'inspect', workspaceId: grant.id };
  await assert.rejects(engine.relay.accept(input), /lost response/);
  const executionId = service.store.readTask(remote.id).executionId;
  assert.equal(engine.store.tasks().length, 0);
  const id = await engine.relay.accept(input);
  await engine.active.get(id)?.done;
  await engine.relay.refresh();
  assert.equal(service.store.readTask(remote.id).executionId, executionId);
  assert.equal(engine.store.tasks().length, 1);
});
test('pairing refuses unsafe origins and phone credentials in the desktop runtime', () => {
  for (const url of ['http://relay.example', 'https://u:p@relay.example', 'https://relay.example/path', 'https://relay.example/?token=bad'])
    assert.equal(pairingSchema.safeParse({ version: 1, url, device: 'mac', token: 'm'.repeat(43) }).success, false);
  assert.equal(pairingSchema.safeParse({ version: 1, url: 'https://relay.example', device: 'phone', token: 'p'.repeat(43) }).success, false);
});

test('logout stops remote admissions, clears visible account cache and allows reconnect without losing saved tasks', async t => {
  const { engine, pairing } = await fixture(t);
  await engine.relay.connect(pairing);
  assert(engine.snapshot().relay.configured);
  await engine.relay.disconnect();
  assert.equal(engine.relay.key, undefined); assert.equal(engine.hub.closed, true);
  assert.equal(engine.snapshot().relay.configured, false); assert.deepEqual(engine.snapshot().hub.items, []);
  await engine.relay.connect(pairing); assert.equal(engine.hub.closed, false);
  assert.equal(engine.snapshot().relay.inbox.length, 1);
});

test('a failed result upload does not block new inbox tasks and can safely retry', async t => {
  const { engine, service, remote, pairing, folderForTask, address } = await fixture(t);
  await engine.relay.connect(pairing);
  const grant = await engine.authorizeWorkspace(folderForTask);
  const id = await engine.relay.accept({ id: remote.id, kind: 'inspect', workspaceId: grant.id });
  await engine.active.get(id)?.done;
  let rejectFinish = true;
  engine.relay.fetcher = (url, opts) => rejectFinish && url.endsWith('/finish')
    ? Promise.resolve(new Response('{}', { status: 409 }))
    : fetch(url.replace('https://relay.example', address), opts);
  const next = service.store.create({ id: 'phone', publishTo: ['/tasks/mac'] }, {
    requestId: randomUUID(), mailbox: '/tasks/mac', title: 'Next', instructions: 'Another test only',
  });
  await engine.relay.refresh();
  assert.equal(engine.snapshot().relay.connected, true);
  assert.equal(engine.snapshot().relay.inbox[0].id, next.id);
  assert.match(engine.snapshot().relay.deliveries[0].error, /回传未确认/);
  assert.equal(engine.snapshot().relay.deliveries[0].returned, false);
  rejectFinish = false;
  await engine.relay.refresh();
  assert.equal(engine.snapshot().relay.deliveries[0].returned, true);
  assert.equal(engine.snapshot().relay.deliveries[0].error, '');
  assert.equal(engine.store.tasks().length, 1);
});
