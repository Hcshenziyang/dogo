import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
const root = join(homedir(), '.local/share/dogo/relay');
const phone = JSON.parse(readFileSync(join(root, 'phone.json'), 'utf8'));
const mac = JSON.parse(readFileSync(join(root, 'mac.json'), 'utf8'));
async function request(identity, path, body, expected = 200, headers = {}) {
  const response = await fetch(identity.url + path, { method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${identity.token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(15000) });
  assert.equal(response.status, expected, `${path}: HTTP ${response.status}`);
  return response.json();
}
assert.equal((await fetch(phone.url + '/v1/identity')).status, 401);
assert.equal((await request(phone, '/v1/identity')).device, 'phone');
assert.equal((await request(mac, '/v1/identity')).device, 'mac');
await request(phone, '/v1/identity', undefined, 403, { Origin: 'https://example.com' });
await request(phone, '/v1/memory', undefined, 404);
const input = { requestId: `smoke_${randomUUID()}`, mailbox: '/tasks/mac', title: 'DogO deployment smoke test',
  instructions: 'Synthetic connectivity test only. Do not read personal files or call a model.' };
const task = await request(phone, '/v1/tasks', input);
assert.equal((await request(phone, '/v1/tasks', input)).id, task.id);
const executionId = randomUUID();
await request(phone, `/v1/tasks/${task.id}/claim`, { executionId }, 403);
await request(mac, '/v1/heartbeat', {});
await request(mac, `/v1/tasks/${task.id}/claim`, { executionId });
await request(mac, `/v1/tasks/${task.id}/progress`, { executionId, message: 'Synthetic roundtrip verified' });
await request(mac, `/v1/tasks/${task.id}/finish`, { executionId, status: 'succeeded', result: 'DogO HTTPS phone -> Mac -> phone roundtrip OK (synthetic)' });
const result = await request(phone, `/v1/tasks/${task.id}`);
assert.equal(result.status, 'succeeded');
assert.match(result.result, /roundtrip OK/);
console.log(JSON.stringify({ origin: phone.url, taskId: task.id, authentication: 'OK', deviceIsolation: 'OK', idempotency: 'OK', memoryDisabled: true, result: result.result }));
