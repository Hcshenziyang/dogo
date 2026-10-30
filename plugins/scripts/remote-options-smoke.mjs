// Run only against a disposable FastAPI account and isolated official DSH profile.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

const cache = process.env.EVAL_CACHE;
if (!cache) throw Error('Set EVAL_CACHE to the isolated test directory');
const log = await readFile(cache + '/host.log', 'utf8');
const launch = log.match(/http:\/\/127\.0\.0\.1:18185\/\?token=[^\s]+/)?.[0];
if (!launch) throw Error('Isolated DSH has not started');
const bootstrap = await fetch(launch, { redirect: 'manual' });
const cookie = bootstrap.headers.get('set-cookie')?.split(';')[0];
assert(cookie);
async function call(path, method, payload) {
  const response = await fetch('http://127.0.0.1:18185' + path, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method, payload }),
  });
  const result = (await response.json()).result;
  if (!result?.ok) throw Error(result?.error?.message || 'RPC failed');
  return result.value;
}
const control = (method, args = {}) => call('/dogo-devices/' + method, method, args);
const native = (method, request) => call('/api/' + method, method, { args: { request } });
async function until(fn) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const result = await fn();
    if (result) return result;
    await delay(150);
  }
  throw Error('Timed out waiting for native session');
}
const account = JSON.parse(await readFile(cache + '/account.json', 'utf8'));
const status = await control('login', {
  server: 'http://127.0.0.1:18184',
  ...account,
  name: 'Options Host B',
});
await control('configure', { enabled: true, cwd: cache });
await until(async () => (await control('status')).consumer.online);
const remote = async (method, args = {}) =>
  (await control('remote', { device_id: status.deviceId, method, args })).value;
const first = (await native('workspace/create', { path: cache + '/project-one' })).workspace;
const second = (await native('workspace/create', { path: cache + '/project-two' })).workspace;
const projects = await remote('workspaces');
assert(projects.items.some((w) => w.workspaceId === first.workspaceId));
assert(projects.items.some((w) => w.workspaceId === second.workspaceId));
const models = await remote('models');
assert(
  models.groups.some((g) => g.id === 'dogo-eval' && g.models.some((m) => m.id === 'fixture-alt')),
);

const sessionId = 'dogo-' + crypto.randomUUID();
const creation = { sessionId, workspaceId: first.workspaceId };
assert.equal((await remote('create', creation)).sessionId, sessionId);
assert.equal((await remote('create', creation)).sessionId, sessionId);
assert.equal((await remote('snapshot', { sessionId })).header.cwd, first.path);
assert(
  (await remote('workspaces')).items
    .find((w) => w.workspaceId === first.workspaceId)
    .sessionIds.includes(sessionId),
);
const selection = { provider: 'dogo-eval', model: 'fixture-alt', reasoningEffort: 'high' };
assert.deepEqual((await remote('selectModel', { sessionId, ...selection })).selected, selection);
const marker = 'continue-' + crypto.randomUUID();
assert(
  (await remote('prompt', { sessionId, requestId: crypto.randomUUID(), text: marker })).accepted,
);
const snapshot = await until(async () => {
  const value = await remote('snapshot', { sessionId });
  return JSON.stringify(value).includes('EVAL_REPLY:' + marker) && value;
});
const request = snapshot.records.find((r) => r.event?.type === 'request/header').event.data.header
  .config;
assert.equal(request.model, 'fixture-alt');
assert.equal(request.reasoningEffort, 'high');
assert.deepEqual(snapshot.projections.values.modelSelection.next, selection);
const secondSession = 'dogo-' + crypto.randomUUID();
await remote('create', { sessionId: secondSession, workspaceId: second.workspaceId });
const ungrouped = 'dogo-' + crypto.randomUUID();
await remote('create', { sessionId: ungrouped });
assert.equal((await remote('snapshot', { sessionId: ungrouped })).header.cwd, cache);
await assert.rejects(() =>
  remote('create', { sessionId: 'dogo-' + crypto.randomUUID(), workspaceId: 'missing-project' }),
);
await assert.rejects(() =>
  remote('selectModel', { sessionId, provider: 'dogo-eval', model: 'missing-model' }),
);
assert.equal(
  (await remote('snapshot', { sessionId })).projections.values.modelSelection.next.model,
  'fixture-alt',
);
const result = {
  passed: true,
  checks: [
    'remote-workspaces',
    'remote-model-catalog',
    'project-directory-and-membership',
    'stable-create-retry',
    'native-model-and-reasoning-execution',
    'ungrouped-fallback',
    'invalid-project-and-model-rejected',
  ],
  deviceId: status.deviceId,
  sessionId,
  first,
  second,
};
await writeFile(cache + '/options-results.json', JSON.stringify(result, null, 2));
console.log(JSON.stringify({ passed: result.passed, checks: result.checks }, null, 2));
