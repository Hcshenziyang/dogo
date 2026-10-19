import test from 'node:test';
import assert from 'node:assert/strict';
import { HubSession } from './client.ts';

function fixture() {
  let disk: string | null = null, online = true, failDisk = false, loseResponse = false;
  let device = 'phone', url = 'https://relay.example';
  const delivered = new Map<string, unknown>();
  const storage = { get: async () => disk, set: async (value: string) => { if (failDisk) throw new Error('disk failed'); disk = value; } };
  const transport = {
    status: async () => ({ configured: true, url, device }),
    hub: async ({ op, args }: any) => {
      if (!online) throw new Error('offline');
      if (op === 'snapshot') return { items: [{ id: 's1', type: 'session', title: 'Fixture', owner: 'mac' }], hasMore: false };
      if (op === 'history') return { messages: [{ id: 'm1', role: 'assistant', text: 'saved', at: 1, seq: 1 }], hasMore: false };
      delivered.set(args.requestId, args);
      if (loseResponse) { loseResponse = false; throw new Error('response lost'); }
      return {};
    },
  };
  return { storage, transport, delivered, online: (v: boolean) => { online = v; }, failDisk: (v: boolean) => { failDisk = v; },
    loseResponse: () => { loseResponse = true; }, device: (v: string) => { device = v; }, url: (v: string) => { url = v; } };
}
test('durable outbox survives lost response and restart; cached history stays readable offline', async () => {
  const f = fixture(), a = new HubSession(f.transport, f.storage);
  await a.refresh(); await a.history('s1'); f.loseResponse();
  const requestId = await a.send('create', { target: 'mac', title: 'Fixture', prompt: 'Synthetic only' });
  assert.equal(a.snapshot().outbox.length, 1);
  const b = new HubSession(f.transport, f.storage); f.online(false); await b.refresh();
  assert.equal(b.snapshot().history.s1[0].text, 'saved');
  assert.equal(b.snapshot().outbox[0].id, requestId);
  f.online(true); await b.refresh();
  assert.equal(f.delivered.size, 1); assert.equal(b.snapshot().outbox.length, 0);
});
test('draft fields, attachments and session replies persist without stale parallel updates', async () => {
  const f = fixture(), a = new HubSession(f.transport, f.storage); await a.load();
  await Promise.all([a.draft({ text: 'typed text' }), a.draft({ title: 'title' }), a.draft({ attachments: [{ name: 'fixture.txt', mime: 'text/plain', data: 'b2s=' }] }), a.reply('s1', 'continue')]);
  const b = new HubSession(f.transport, f.storage); await b.load();
  assert.equal(b.snapshot().draft.text, 'typed text'); assert.equal(b.snapshot().draft.title, 'title');
  assert.equal(b.snapshot().draft.attachments[0].name, 'fixture.txt'); assert.equal(b.snapshot().replies.s1, 'continue');
});
test('disk failure prevents send; changing device or server cannot replay another identity outbox', async () => {
  const f = fixture(), a = new HubSession(f.transport, f.storage); await a.load();
  f.failDisk(true); await assert.rejects(a.send('note', { text: 'x' }), /disk/); assert.equal(f.delivered.size, 0);
  f.failDisk(false); f.online(false); await a.send('note', { text: 'pending' });
  f.device('phone2'); f.online(true); await a.refresh(); assert.equal(a.snapshot().outbox.length, 0); assert.equal(f.delivered.size, 0);
  f.device('phone'); f.url('https://another.example'); await a.refresh(); assert.equal(f.delivered.size, 0);
  f.url('https://relay.example'); await a.refresh(); assert.equal(f.delivered.size, 1);
});
