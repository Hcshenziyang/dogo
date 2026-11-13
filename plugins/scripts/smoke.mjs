// Opt-in integration test against the isolated official DSH and disposable FastAPI account.
import { readFile, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';
const cache = process.env.EVAL_CACHE,
  logPath = process.env.EVAL_DSH_LOG;
if (!cache || !logPath) throw Error('Set EVAL_CACHE and EVAL_DSH_LOG for an isolated test profile');
const log = await readFile(logPath, 'utf8');
const url = log.match(/http:\/\/127\.0\.0\.1:18185\/\?token=[^\s]+/)?.[0];
if (!url) throw Error('Missing isolated DSH launch URL');
const response = await fetch(url, { redirect: 'manual' }),
  cookie = response.headers.get('set-cookie')?.split(';')[0];
assert(cookie);
await writeFile(cache + '/cookie', cookie, { mode: 0o600 });
const account = JSON.parse(await readFile(cache + '/account.json', 'utf8'));
async function rpc(kind, method, payload = {}) {
  const response = await fetch('http://127.0.0.1:18185/dogo-' + kind + '/' + method, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method, payload }),
  });
  assert.equal(response.status, 200);
  const j = await response.json();
  if (!j.result?.ok) throw Error(j.result?.error?.message || 'Control failed');
  return j.result.value;
}
async function until(fn, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await delay(200);
  }
  throw Error('Integration wait timed out');
}
const controlURL = 'http://127.0.0.1:18185/dogo-devices/status';
assert.equal((await fetch(controlURL, { method: 'POST' })).status, 401);
assert.equal(
  (
    await fetch(controlURL, {
      method: 'POST',
      headers: { Cookie: cookie, Origin: 'https://untrusted.invalid' },
    })
  ).status,
  403,
);
const results = [];
const pass = (test) => {
  results.push({ test, passed: true });
  console.log('PASS', test);
};
if (process.argv.includes('--after-restart')) {
  const saved = JSON.parse(await readFile(cache + '/smoke-state.json', 'utf8'));
  const status = await rpc('devices', 'status');
  assert(status.loggedIn);
  assert.equal(status.deviceId, saved.deviceId);
  await until(async () => (await rpc('devices', 'status')).consumer.online);
  const snapshot = (
    await rpc('devices', 'remote', {
      device_id: saved.deviceId,
      method: 'snapshot',
      args: { sessionId: saved.sessionId },
    })
  ).value;
  assert(JSON.stringify(snapshot).includes(saved.marker));
  pass('installed-plugin-restart-restores-auth-device-and-history');
} else {
  const status = await rpc('devices', 'login', {
    server: process.env.EVAL_SERVER || 'http://127.0.0.1:18184',
    ...account,
    name: 'Plugin Host B',
  });
  pass('device-plugin-login');
  await rpc('devices', 'configure', { enabled: true, cwd: cache });
  await until(async () => (await rpc('devices', 'status')).consumer.online);
  const marker = 'queue-' + crypto.randomUUID();
  const sessionId = 'dogo-' + crypto.randomUUID();
  const remote = async (method, args) =>
    (await rpc('devices', 'remote', { device_id: status.deviceId, method, args })).value;
  await remote('create', { sessionId });
  await remote('prompt', { sessionId, requestId: crypto.randomUUID(), text: marker });
  await until(async () =>
    JSON.stringify(await remote('snapshot', { sessionId })).includes('EVAL_REPLY:' + marker),
  );
  pass('installed-device-plugin-creates-and-runs-native-session');
  const listing = await remote('list', {});
  assert(listing.items.some((s) => s.sessionId === sessionId));
  const text = 'continue-' + crypto.randomUUID(),
    request = { sessionId, requestId: crypto.randomUUID(), text };
  assert((await remote('prompt', request)).accepted);
  await delay(2200);
  assert((await remote('prompt', request)).accepted);
  await until(async () =>
    JSON.stringify(await remote('snapshot', { sessionId })).includes('EVAL_REPLY:' + text),
  );
  const attempts = (await readFile(cache + '/model-attempts.jsonl', 'utf8'))
    .trim()
    .split('\n')
    .map(JSON.parse);
  assert.equal(attempts.filter((a) => a.phase === 'start' && a.text === text).length, 1);
  pass('dogo-relay-continues-native-session-with-request-dedup');
  const stoppedSession = 'dogo-' + crypto.randomUUID(),
    stoppedText = 'continue-' + crypto.randomUUID();
  await remote('create', { sessionId: stoppedSession });
  await remote('prompt', {
    sessionId: stoppedSession,
    requestId: crypto.randomUUID(),
    text: stoppedText,
  });
  await until(async () =>
    (await readFile(cache + '/model-attempts.jsonl', 'utf8')).includes(
      JSON.stringify({ text: stoppedText, phase: 'start' }),
    ),
  );
  await remote('cancel', { sessionId: stoppedSession });
  const stopped = await until(async () => {
    const s = await remote('snapshot', { sessionId: stoppedSession });
    return s.records?.some((r) => r.event?.type === 'turn/end') && s;
  });
  assert(!JSON.stringify(stopped).includes('EVAL_REPLY:' + stoppedText));
  assert(
    !stopped.records.some(
      (r) => r.event?.type === 'turn/end' && r.event.data?.reason?.kind === 'completed',
    ),
  );
  pass('remote-stop-cancels-the-native-running-turn');
  await writeFile(
    cache + '/smoke-state.json',
    JSON.stringify({ deviceId: status.deviceId, sessionId, marker }),
  );
}
await writeFile(
  cache +
    (process.argv.includes('--after-restart')
        ? '/smoke-restart-results.json'
        : '/smoke-results.json'),
  JSON.stringify(results, null, 2),
);
