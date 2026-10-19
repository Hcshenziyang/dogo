import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { WorkspaceRepository, createOutboxTask, retractOutbox } from './workspace.ts';
import { RelaySession } from './relay.ts';
import type { NativeRelayTransport } from './relay.ts';

async function fixture() {
  const values = new Map<string, string>();
  let failWrites = false;
  const storage = { get: async (key: string) => values.get(key) ?? null,
    set: async (key: string, value: string) => { if (failWrites) throw new Error('disk full'); values.set(key, value); } };
  const repo = new WorkspaceRepository(storage); await repo.load();
  const task = createOutboxTask({ title: 'Test', description: 'Test only', device: 'mac' }, repo.snapshot().connection);
  await repo.update(state => ({ ...state, localTasks: [task] }));
  const response = { id: randomUUID(), requestId: task.requestId!, mailbox: task.mailbox!, sender: 'phone', status: 'queued', progress: null as string | null, result: null as string | null, updatedAt: 1 };
  const native: NativeRelayTransport = { status: async () => ({ configured: true, url: 'https://relay.example', device: 'phone' }),
    importPairing: async () => ({ configured: true, url: 'https://relay.example', device: 'phone' }),
    identity: async () => ({ device: 'phone', services: ['tasks'] }), publish: async () => response, read: async () => response };
  return { task, repo, response, native, storage, session: new RelaySession(repo, native), fail: () => { failWrites = true; } };
}
test('explicit publish and result refresh persist a real roundtrip, no demo publication', async () => {
  const { task, repo, response, session, native } = await fixture();
  let sends = 0; native.publish = async () => { sends++; return response; };
  await session.refresh(); assert.equal(sends, 0);
  await session.publish(task.id); assert.equal(sends, 1);
  assert.equal(repo.snapshot().localTasks[0].remoteId, response.id);
  response.status = 'succeeded'; response.result = 'Result'; response.updatedAt = 2;
  await session.refresh();
  assert.deepEqual(repo.snapshot().localTasks[0].result, ['Result']);
  assert.equal(repo.snapshot().localTasks[0].unread, true);
  await repo.update(state => ({ ...state, mode: 'demo' }));
  await assert.rejects(session.publish(task.id), /演示/);
});
test('ambiguous delivery persists destination, forbids local retraction, retries same requestId after restart', async () => {
  const { task, repo, response, session, native, storage } = await fixture();
  let seen: string | undefined;
  native.publish = async ({ input }) => { seen = input.requestId; throw new Error('timeout'); };
  await assert.rejects(session.publish(task.id), /timeout/);
  const queued = repo.snapshot().localTasks;
  assert.equal(queued[0].sendAttempted, true);
  assert.equal(retractOutbox(queued, task.id)[0].status, 'outbox');
  const resumed = new WorkspaceRepository(storage); await resumed.load();
  native.publish = async ({ input }) => { assert.equal(input.requestId, seen); return response; };
  native.status = async () => ({ configured: true, url: 'https://other.example', device: 'phone' });
  await assert.rejects(new RelaySession(resumed, native).publish(task.id), /原服务/);
  native.status = async () => ({ configured: true, url: 'https://relay.example', device: 'phone' });
  await new RelaySession(resumed, native).publish(task.id);
  assert.equal(resumed.snapshot().localTasks[0].status, 'queued');
});
test('disk failure before send cannot create a remote task', async () => {
  const { task, session, fail, native } = await fixture();
  let sent = false; native.publish = async () => { sent = true; return {}; };
  fail(); await assert.rejects(session.publish(task.id), /disk full/); assert.equal(sent, false);
});

test('one unavailable task cannot block other result refreshes', async () => {
  const { task, repo, response, session, native } = await fixture();
  await session.publish(task.id);
  const second = createOutboxTask({ title: 'Second', description: 'Test only', device: 'mac' }, repo.snapshot().connection);
  await repo.update(state => ({ ...state, localTasks: [...state.localTasks, second] }));
  const next = { ...response, id: randomUUID(), requestId: second.requestId!, status: 'queued' };
  native.publish = async () => next;
  await session.publish(second.id);
  native.read = async ({ id }) => {
    if (id === response.id) throw new Error('HTTP 404');
    return { ...next, status: 'succeeded', result: 'Second result', updatedAt: 2 };
  };
  await assert.rejects(session.refresh(), /1 个任务暂时无法刷新/);
  assert.equal(repo.snapshot().localTasks[0].status, 'queued');
  assert.deepEqual(repo.snapshot().localTasks[1].result, ['Second result']);
});
