// Prepare or verify approvals against an isolated, locally bound DSH and Rust server.
import assert from 'node:assert/strict';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const cache = process.env.EVAL_CACHE;
const home = process.env.EVAL_DSH_HOME;
const logPath = process.env.EVAL_DSH_LOG;
const server = process.env.EVAL_SERVER || 'http://127.0.0.1:18789';
if (!cache || !home || !logPath || ![cache, home, logPath].every(isAbsolute) || !/^http:\/\/127\.0\.0\.1:\d+$/.test(server))
  throw Error('Set temporary EVAL_CACHE, EVAL_DSH_HOME, EVAL_DSH_LOG and a loopback-only EVAL_SERVER.');
const roots = await Promise.all(['/tmp', tmpdir()].map((root) => realpath(root)));
for (const path of [cache, home, logPath]) {
  const resolved = await realpath(path);
  if (!roots.some((root) => resolved.startsWith(root + sep))) throw Error('All test paths must be temporary.');
}
const launch = (await readFile(logPath, 'utf8')).match(/http:\/\/127\.0\.0\.1:18185\/\?token=[^\s]+/)?.[0];
if (!launch) throw Error('Isolated DSH must listen on 127.0.0.1:18185.');
const cookie = (await fetch(launch, { redirect: 'manual' })).headers.get('set-cookie')?.split(';')[0];
assert(cookie);
async function control(method, payload = {}) {
  const response = await fetch('http://127.0.0.1:18185/dogo-devices/' + method, {
    method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method, payload }),
  });
  const result = (await response.json()).result;
  if (!result?.ok) throw Error(result?.error?.message || 'Control failed');
  return result.value;
}
async function until(fn) {
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) { const result = await fn(); if (result) return result; await delay(250); }
  throw Error('Native approval wait timed out');
}
const mode = process.argv[2];
if (!['prepare', 'verify'].includes(mode)) throw Error('Use prepare or verify.');
let status = await control('status');
if (mode === 'prepare') {
  const account = JSON.parse(await readFile(cache + '/account.json', 'utf8'));
  status = await control('login', { server, ...account, name: 'Native Harness Test' });
  await control('configure', { enabled: true, cwd: cache });
}
await until(async () => (await control('status')).consumer.online);
const remote = async (method, args = {}) =>
  (await control('remote', { device_id: status.deviceId, method, args })).value;
const state = cache + '/approval-smoke-state.json';
if (mode === 'prepare') {
  const sessions = [];
  for (const decision of ['allowed-once', 'rejected']) {
    const sessionId = 'dogo-' + crypto.randomUUID();
    await remote('create', { sessionId });
    await remote('prompt', { sessionId, requestId: crypto.randomUUID(),
      text: decision === 'allowed-once' ? '手机真实审批允许' : '手机真实审批拒绝' });
    const snapshot = await until(async () => {
      const value = await remote('snapshot', { sessionId });
      return value.dogoApprovals?.items?.length && value;
    });
    assert(snapshot.dogoApprovals.items[0].detailAvailable);
    sessions.push({ sessionId, decision });
  }
  await writeFile(state, JSON.stringify(sessions));
  console.log('Prepared two isolated native approvals.');
} else {
  for (const entry of JSON.parse(await readFile(state, 'utf8'))) {
    const snapshot = await until(async () => {
      const value = await remote('snapshot', { sessionId: entry.sessionId });
      return value.records?.some((record) => record.event?.type === 'turn/end') && value;
    });
    const events = snapshot.records.map((record) => record.event);
    assert(events.some((event) => event?.type === 'approval/decided' && event.data.outcome === entry.decision));
    const result = events.find((event) => event?.type === 'tool/result')?.data;
    assert(result);
    assert.equal(result.message.isError, entry.decision === 'rejected');
    if (entry.decision === 'allowed-once') assert(JSON.stringify(result).includes('synthetic-approval'));
    assert.equal(snapshot.dogoApprovals.items.length, 0);
    console.log('PASS Android to native Harness:', entry.decision);
  }
}
