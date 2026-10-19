import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { fixture } from './helpers.ts';
import { CHUNK_SIZE } from '../src/artifacts.ts';
import { HubSession } from '../../../../packages/hub-ui/src/client.ts';

test('attachment chunks are immutable, bounded, verified and authorized before execution can be queued', async t => {
  const { service } = await fixture(t);
  const [mac, phone, win] = service.store.config.devices;
  const data = Buffer.alloc(CHUNK_SIZE + 7, 'x'), id = randomUUID();
  const begin = { id, target: 'mac', name: 'synthetic.txt', mime: 'text/plain', size: data.length, sha256: createHash('sha256').update(data).digest('hex') };
  const call = (op: string, args: unknown, device = phone) => service.hub.execute(device, op, args);
  call('advertise', { instance: randomUUID(), name: 'Fixture Mac', ready: true, projects: [] }, mac);
  call('artifactBegin', begin); call('artifactBegin', begin);
  const task = { requestId: randomUUID(), target: 'mac', title: 'Fixture', prompt: 'Read the attachment', artifactIds: [id] };
  assert.throws(() => call('create', task), /incomplete/); assert.equal(service.hub.all('command').length, 0);
  assert.throws(() => call('artifactSeal', { id }), /incomplete/);
  assert.throws(() => call('artifactBegin', { ...begin, name: '../escape' }));
  assert.throws(() => call('artifactRead', { id }, win), /revoked/);
  const first = { id, index: 0, data: data.subarray(0, CHUNK_SIZE).toString('base64') };
  call('artifactChunk', first); call('artifactChunk', first);
  assert.throws(() => call('artifactChunk', { ...first, data: Buffer.alloc(CHUNK_SIZE, 'y').toString('base64') }), /immutable/);
  call('artifactChunk', { id, index: 1, data: data.subarray(CHUNK_SIZE).toString('base64') });
  assert.equal(call('artifactSeal', { id }).state, 'ready');
  const command = call('create', task); assert.deepEqual(command.artifactIds, [id]); assert.equal(command.attachments, undefined);
  assert(!JSON.stringify(service.hub.all('command')).includes(first.data));
  assert.equal(call('artifactRead', { id }, mac).sha256, begin.sha256);
  assert.throws(() => call('artifactChunk', { id, index: 2, data: 'eA==' }), /size/);
});

test('durable client resumes uploads after a lost chunk response; note conversion retains references and receipt stages', async t => {
  const { service } = await fixture(t); const [mac, phone] = service.store.config.devices;
  const call = (op: string, args: unknown, device = phone) => service.hub.execute(device, op, args);
  call('advertise', { instance: randomUUID(), name: 'Fixture Mac', ready: true, projects: [] }, mac);
  let disk: string | null = null, lose = true;
  const transport = { status: async () => ({ configured: true, url: 'https://fixture.test', device: 'phone' }),
    hub: async ({ op, args }: any) => { const result = call(op, args); if (op === 'artifactChunk' && lose) { lose = false; throw new Error('response lost'); } return result; } };
  const storage = { get: async () => disk, set: async (v: string) => { disk = v; } };
  const client = new HubSession(transport, storage);
  await client.refresh();
  const noteId = await client.send('note', { target: 'mac', title: 'Synthetic material', text: 'Preserve me', attachments: [{ name: 'fixture.txt', mime: 'text/plain', data: Buffer.from('SYNTHETIC_ARTIFACT_731').toString('base64') }] });
  assert.equal(client.snapshot().outbox.length, 1); assert.equal(service.hub.all('note').length, 0);
  const restored = new HubSession(transport, storage); await restored.refresh();
  assert.equal(restored.snapshot().outbox.length, 0);
  assert.equal(service.store.db.prepare('SELECT COUNT(*) AS count FROM hub_artifacts').get()!.count, 1);
  const note = call('get', { id: noteId, type: 'note' }); assert.equal(note.artifactIds.length, 1); assert.equal(note.attachments.length, 0);
  const file = await restored.artifact(note.artifactIds[0]); assert.equal(new TextDecoder().decode(file.bytes), 'SYNTHETIC_ARTIFACT_731');
  call('noteState', { id: noteId, state: 'read' });
  const received = call('noteState', { id: noteId, state: 'received' }, mac);
  assert.equal(received.state, 'read'); assert(received.receivedAt); assert(received.readAt);
  const requestId = randomUUID();
  const task = call('create', { requestId, target: 'mac', title: 'From material', prompt: 'Analyze', sourceNoteId: noteId });
  assert.deepEqual(task.artifactIds, note.artifactIds);
  assert.equal(service.hub.get('session', task.sessionId).sourceNoteId, noteId);
  assert.deepEqual(service.hub.get('note', noteId).linkedSessions, [task.sessionId]);
  assert.equal(service.hub.get('note', noteId).text, 'Preserve me');
  call('create', { requestId, target: 'mac', title: 'From material', prompt: 'Analyze', sourceNoteId: noteId });
  assert.equal(service.hub.get('note', noteId).linkedSessions.length, 1);
});

test('incorrect checksum cannot be sealed and legacy note conversion cannot silently drop attachments', async t => {
  const { service } = await fixture(t); const [mac, phone] = service.store.config.devices;
  const call = (op: string, args: unknown, device = phone) => service.hub.execute(device, op, args);
  call('advertise', { instance: randomUUID(), name: 'Fixture Mac', ready: true, projects: [] }, mac);
  const id = randomUUID(); call('artifactBegin', { id, target: 'mac', name: 'bad.txt', mime: 'text/plain', size: 1, sha256: '0'.repeat(64) });
  call('artifactChunk', { id, index: 0, data: 'eA==' }); assert.throws(() => call('artifactSeal', { id }), /checksum/);
  const note = call('note', { requestId: randomUUID(), target: 'mac', title: 'Legacy', text: 'Legacy body', attachments: [{ name: 'old.txt', mime: 'text/plain', data: 'eA==' }] });
  assert.throws(() => call('create', { requestId: randomUUID(), target: 'mac', title: 'Copy', prompt: 'Use file', sourceNoteId: note.id }), /legacy note attachments/);
  assert.equal(service.hub.all('session').length, 0);
});
