// Run with tsx's loader; imports the pinned upstream source, never the user's DSH profile.
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
const cache = process.env.EVAL_CACHE;
const upstream = process.env.EVAL_UPSTREAM;
if (!cache || !upstream) throw new Error('Set EVAL_CACHE and EVAL_UPSTREAM');
const load = p => import(pathToFileURL(join(upstream, p)));
const { IdentityStore } = await load('packages/plugin/src/identity-store.ts');
const { ServerCredentialStore } = await load('packages/plugin/src/server-credentials.ts');
const { ClientServerApi } = await load('packages/plugin/src/server-api.ts');
const { ClientSecureTransport } = await load('packages/plugin/src/client-secure-transport.ts');
const { RelayTransport } = await load('packages/webrtc/src/index.ts');
const { RemoteClientCore } = await load('packages/client-core/src/index.ts');
const { RemoteTypertGateway } = await load('packages/plugin/src/remote-typert-gateway.ts');
const base = 'http://127.0.0.1:18180';
const clientDirectory = join(cache, 'probe-client-' + Date.now());
const identity = await new IdentityStore({ directory: clientDirectory }).loadOrCreate('DogO Test Client');
const api = new ClientServerApi(base, new ServerCredentialStore(clientDirectory), fetch, 'client');
const account = JSON.parse(await readFile(join(cache, 'fixture-account.json'), 'utf8'));
await api.authorizeWithAccount(identity, account.account, account.password);
const hosts = await api.listDevices();
const host = hosts.find(d => d.name === 'DogO Evaluation Host' && d.online);
if (!host) throw Error('Evaluation host not online');
const peer = await api.deviceFor(host.deviceId);
const credentials = await api.authenticate();
async function connect() {
const transport = new RelayTransport(base.replace('http:', 'ws:') + '/ws/v1/connect', {
  role: 'client', deviceId: identity.deviceId, accessToken: credentials.accessToken, targetDeviceId: host.deviceId,
});
const secure = new ClientSecureTransport(transport, identity, {
  ...peer, publicKey: peer.identityKey, fingerprint: 'evaluation', trustedAt: Date.now(),
});
const client = new RemoteClientCore(secure, 10000);
await client.connect();
return { client, gateway: new RemoteTypertGateway(client) };
}
let { client, gateway } = await connect();
const results = [];
const record = (test, details = {}) => { results.push({ test, passed: true, ...details }); console.log('PASS', test); };
const invoke = (method, args) => gateway.invoke({ namespace: 'session', method, args });
async function snapshot(sessionId) {
  const abort = new AbortController();
  const stream = await gateway.open('session/follow', { args: { request: { address: { kind: 'session', sessionId } } } }, abort.signal);
  try { return (await stream[Symbol.asyncIterator]().next()).value; } finally { abort.abort(); }
}
try {
  record('encrypted-relay-connect');
  const features = await client.rpc('harness.transport.describe', {});
  record('host-capabilities', { features });
  const list = await invoke('list', { _request: {} });
  assert(Array.isArray(list.items)); record('native-session-list');
  const requestedId = randomUUID();
  const created = await invoke('create', { request: { sessionId: requestedId, cwd: cache } });
  const sessionId = created.sessionId;
  assert.equal(sessionId, requestedId); record('native-session-create', { sessionId });
  await invoke('selectModel', { request: { sessionId, provider: 'dogo-eval', model: 'fixture' } });
  const firstText = 'disconnect-' + randomUUID();
  const request = { sessionId, requestId: randomUUID(), mode: 'queue', content: [{ type: 'text', text: firstText }] };
  assert.equal((await invoke('prompt', { request })).accepted, true);
  await delay(400);
  await client.close();
  await delay(2600);
  ({ client, gateway } = await connect());
  let view = await snapshot(sessionId);
  await writeFile(join(cache, 'session-snapshot.json'), JSON.stringify(view, null, 2));
  assert(JSON.stringify(view).includes('EVAL_REPLY:' + firstText));
  record('client-disconnect-host-completes-and-history-recovers');
  // Re-send exactly the same native request id after the client reconnects.
  await invoke('prompt', { request });
  await delay(2200);
  const attempts = (await readFile(join(cache, 'model-attempts.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(attempts.filter(a => a.phase === 'start' && a.text === firstText).length, 1);
  record('same-native-request-id-no-second-model-run');
  const secondText = 'continue-' + randomUUID();
  await invoke('prompt', { request: { ...request, requestId: randomUUID(), content: [{ type: 'text', text: secondText }] } });
  await delay(2500);
  view = await snapshot(sessionId);
  assert(JSON.stringify(view).includes(firstText) && JSON.stringify(view).includes(secondText));
  record('continue-same-native-session');
  const times = [];
  for (let i = 0; i < 20; i++) { const start = performance.now(); await invoke('list', { _request: {} }); times.push(performance.now() - start); }
  times.sort((a,b) => a-b); record('local-relay-roundtrip', { samples: 20, medianMs: times[10], p95Ms: times[18] });
  await writeFile(join(cache, 'session-id'), sessionId);
  await api.revokeCurrentDevice();
  await delay(250);
  await assert.rejects(() => invoke('list', { _request: {} }));
  record('revocation-closes-live-remote-access');
} catch (e) {
  results.push({ test: 'native-relay-flow', passed: false, code: e.code, message: e.message });
  console.error(e); process.exitCode = 1;
} finally {
  await writeFile(join(cache, 'relay-probe.json'), JSON.stringify(results, null, 2));
  await client.close(); api.close();
}
