import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as memory from 'dsh-native-memory';

// Resolve the exact DSH dependencies shipped with desktop; never mock Session.events.
const require = createRequire(import.meta.url);
const dsh = createRequire(require.resolve('@deepseek-ai/dsh/package.json'));
const { Context } = await import(dsh.resolve('@deepseek-ai/cordis'));
const { SessionStore } = await import(dsh.resolve('@deepseek-ai/dsh-session'));
const { Storage } = await import(dsh.resolve('@deepseek-ai/dsh-storage'));
const { DomainFacility } = await import(dsh.resolve('@deepseek-ai/dsh-storage-domain'));
const { JsonStorageBackend } = await import(dsh.resolve('@deepseek-ai/dsh-storage-json'));

function fixture(directory, approval = async () => 'allowed-once') {
  const ctx = new Context(), tools = new Map(), asks = [];
  new SessionStore(ctx); new Storage(ctx);
  const backend = new JsonStorageBackend(directory);
  ctx.storage.backend.register('json', backend);
  const domains = new DomainFacility(ctx, { backend: 'json' });
  ctx.provide('storageDomain', domains);
  // Only registration and the human response are test seams. Plugin tool implementations,
  // SessionStore, domain validation and on-disk persistence are the installed dependencies.
  ctx.provide('tools', { register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name); } });
  if (approval) ctx.provide('approval', { async request(input) { asks.push(input); return approval(input); } });
  memory.apply(ctx, { injectProfile: false });
  const session = ctx.sessions.create('session-memory-fixture', { meta: { cwd: path.join(directory, 'workspace') } });
  const agent = { session };
  const signal = new AbortController().signal;
  return { ctx, tools, asks, session,
    call: (name, args = {}) => tools.get(name).execute(args, { agent, callId: 'fixture-call', signal }),
    facts: () => [...domains.get('dsh_memory').table('facts').entries()].map(([, value]) => value),
    async close() { await ctx.fiber.dispose(); await domains.closeAll(); await backend.close(); },
  };
}
async function directory(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'dogo-native-memory-'));
  t.after(() => rm(root, { recursive: true, force: true })); return root;
}

test('native memory uses real Session.seq for remember/edit provenance and survives storage reopen', async t => {
  const root = await directory(t);
  let host = fixture(root, async ({ agent }) => {
    // Approval may itself append audit events. Provenance must retain the offset
    // observed on entry to the tool, rather than a later offset after approval.
    agent.session.append('fixture/approval', { outcome: 'allowed-once' });
    return 'allowed-once';
  }); t.after(() => host.close());
  assert.equal(host.session.events, undefined);
  assert.equal(host.session.seq, 0);
  assert.match(await host.call('memory_recall', { query: 'DuplexJev', limit: 5 }), /no active facts/);
  host.session.append('fixture/note', { text: 'Before remember' });
  host.session.append('fixture/note', { text: 'One more event' });
  const seq = host.session.seq;
  assert.equal(seq, 2);
  await host.call('memory_remember', { text: 'Synthetic DuplexJev fact', kind: 'fact', tags: ['DuplexJev'] });
  const [saved] = host.facts();
  assert.equal(saved.sessionId, host.session.id); assert.equal(saved.seq, seq);
  assert.equal(host.asks.length, 1); assert.equal(host.asks[0].agent.session, host.session);
  assert.match(await host.call('memory_recall', { query: 'DuplexJev', limit: 5 }), /Synthetic DuplexJev fact/);
  host.session.append('fixture/note', { text: 'Before edit' });
  const editSeq = host.session.seq;
  await host.call('memory_edit', { id: saved.id, text: 'Edited DuplexJev fact' });
  assert.equal(host.facts()[0].seq, editSeq);
  assert.equal(host.session.seq, editSeq + 1);
  assert.equal(host.facts()[0].sessionId, host.session.id);
  const expected = host.facts(); await host.close();
  host = fixture(root);
  assert.match(await host.call('memory_recall', { query: 'DuplexJev', limit: 5 }), /Edited DuplexJev fact/);
  assert.deepEqual(host.facts(), expected);
});

test('memory write refusal, unavailable approval and throwing approval never persist a fact', async t => {
  for (const [label, approval] of [
    ['refused', async () => 'rejected'], ['unavailable', null], ['exception', async () => { throw new Error('fixture approval failure'); }],
  ]) await t.test(label, async t => {
    const root = await directory(t), host = fixture(root, approval); t.after(() => host.close());
    await assert.rejects(host.call('memory_remember', { text: 'Denied fixture' }), { code: 'MEMORY_APPROVAL_DENIED' });
    assert.equal(host.facts().length, 0);
    assert.match(await host.call('memory_recall', { query: 'Denied' }), /no active facts/);
  });
});

test('all eight memory tools reach their intended path with a Session that has no events property', async t => {
  const root = await directory(t), host = fixture(root); t.after(() => host.close());
  assert.equal(host.tools.size, 8);
  await host.call('memory_remember', { text: 'Fixture profile', target: 'profile' });
  assert.match(await host.call('memory_profile'), /Fixture profile/);
  await host.call('memory_remember', { text: 'Fixture fact' });
  const id = host.facts()[0].id;
  await host.call('memory_edit', { id, tags: ['fixture'] });
  assert.match(await host.call('memory_recall', { query: 'fixture' }), /Fixture fact/);
  assert.equal(typeof await host.call('memory_consolidate'), 'string');
  await host.call('memory_forget', { id });
  assert.equal(host.facts()[0].state, 'archived');
  // These optional services are deliberately absent; a documented availability error
  // proves callerOf completed, without claiming this fixture tests the FTS backend.
  await assert.rejects(host.call('memory_search', { query: 'fixture' }), { code: 'MEMORY_DISABLED' });
  await assert.rejects(host.call('memory_import', { session_id: 'past-fixture', query: 'fixture' }), { code: 'MEMORY_DISABLED' });
});
