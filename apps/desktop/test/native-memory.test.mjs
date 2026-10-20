import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as memory from 'dsh-native-memory';
import { legacyMemory } from '../../../packages/dsh-plugin/src/legacy-memory.mjs';
import { memoryInput, memoryVersion } from '../../../packages/dsh-plugin/src/host/scoped-memory.mjs';

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
  ctx.provide('tools', { get: name => tools.get(name), register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name); } });
  if (approval) ctx.provide('approval', { async request(input) { asks.push(input); return approval(input); } });
  memory.apply(ctx, { injectProfile: false });
  const session = ctx.sessions.create('session-memory-fixture', { meta: { cwd: path.join(directory, 'workspace') } });
  const agent = { session };
  const signal = new AbortController().signal;
  const exec = { agent, callId: 'fixture-call', signal };
  return { ctx, tools, asks, session, exec,
    call: (name, args = {}) => tools.get(name).execute(args, exec),
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

test('legacy cleanup reads full facts with versions and archives only the selected workspace fact through native approval', async t => {
  const root = await directory(t), host = fixture(root); t.after(() => host.close());
  await host.call('memory_remember', { text: 'Duplicate fixture ' + 'long text '.repeat(70) });
  await host.call('memory_remember', { text: 'Independent fixture' });
  const policy = { state: { automatic: true }, engine: {} };
  const call = args => legacyMemory(host.ctx, policy, memoryInput.parse({ scope: 'session', scopeId: host.session.id, ...args }), host.exec);
  const read = await call({ action: 'legacy_read', query: 'Duplicate' });
  assert.equal(read.records.length, 1); assert(read.records[0].text.length > 400);
  const { id, version } = read.records[0];
  const otherSession = host.ctx.sessions.create('other-workspace', { meta: { cwd: path.join(root, 'other-workspace') } });
  await host.tools.get('memory_remember').execute({ text: 'Foreign fixture' }, { ...host.exec, agent: { session: otherSession } });
  const foreign = host.facts().find(fact => fact.text === 'Foreign fixture');
  await assert.rejects(call({ action: 'legacy_forget', id: foreign.id, version: memoryVersion(JSON.stringify(foreign)) }), /current workspace/);
  await assert.rejects(call({ action: 'legacy_forget', id, version, scopeId: 'other-session' }), /current session/);
  policy.state.automatic = false;
  await assert.rejects(call({ action: 'legacy_forget', id, version }), /disabled/);
  policy.state.automatic = true;
  const asks = host.asks.length;
  await assert.rejects(call({ action: 'legacy_forget', id, version: '0'.repeat(64) }), /changed/);
  assert.equal(host.asks.length, asks);
  const forget = host.tools.get('memory_forget'), versionSchema = forget.parameters.properties.version;
  delete forget.parameters.properties.version;
  await assert.rejects(call({ action: 'legacy_forget', id, version }), /Update the bundled/);
  forget.parameters.properties.version = versionSchema;
  const archived = await call({ action: 'legacy_forget', id, version });
  assert.equal(archived.archived, true); assert.equal(archived.historyRetained, true);
  assert.equal(archived.sync, 'not-applicable-legacy-workspace');
  assert.equal(host.asks.length, asks + 1);
  assert.equal((await call({ action: 'legacy_read', query: 'Duplicate' })).records.length, 0);
  assert.equal((await call({ action: 'legacy_read', query: 'Independent' })).records.length, 1);
  assert.equal(host.facts().find(fact => fact.id === id).state, 'archived');
  assert.equal(host.facts().find(fact => fact.id === foreign.id).state, 'active');
});

test('legacy archive rejects stale versions, approval-time changes and cancellation; denied approval preserves the fact', async t => {
  for (const scenario of ['changed', 'cancelled', 'denied', 'unavailable']) await t.test(scenario, async t => {
    const root = await directory(t);
    let host, archive = false;
    const abort = new AbortController();
    host = fixture(root, async () => {
      if (!archive) return 'allowed-once';
      if (scenario === 'changed') {
        const old = host.facts()[0];
        await host.ctx.get('storageDomain').get('dsh_memory').table('facts').put(old.id, { ...old, text: 'Concurrent new information' });
      }
      if (scenario === 'cancelled') abort.abort();
      return scenario === 'denied' ? 'rejected' : 'allowed-once';
    });
    t.after(() => host.close());
    await host.call('memory_remember', { text: 'Original fixture' });
    const [fact] = host.facts(), version = memoryVersion(JSON.stringify(fact));
    await assert.rejects(host.call('memory_forget', { id: fact.id, version: '0'.repeat(64) }), { code: 'MEMORY_CONFLICT' });
    archive = true;
    if (scenario === 'unavailable') {
      await host.close(); host = fixture(root, null);
      await assert.rejects(host.call('memory_forget', { id: fact.id, version }), { code: 'MEMORY_APPROVAL_DENIED' });
    } else {
      await assert.rejects(host.tools.get('memory_forget').execute({ id: fact.id, version }, { ...host.exec, signal: abort.signal }),
        scenario === 'changed' ? { code: 'MEMORY_CONFLICT' } : scenario === 'denied' ? { code: 'MEMORY_APPROVAL_DENIED' } : { name: 'AbortError' });
    }
    assert.equal(host.facts()[0].state, 'active');
    if (scenario === 'changed') assert.equal(host.facts()[0].text, 'Concurrent new information');
  });
});

test('turning maintenance off while a legacy approval is pending cancels the archive', async t => {
  const root = await directory(t);
  let deleting = false, release, entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  const host = fixture(root, async () => {
    if (!deleting) return 'allowed-once';
    entered(); return new Promise(resolve => { release = resolve; });
  }); t.after(() => host.close());
  await host.call('memory_remember', { text: 'Keep when maintenance is disabled' });
  const fact = host.facts()[0], policy = { state: { automatic: true }, engine: {}, maintenanceController: new AbortController() };
  deleting = true;
  const pending = legacyMemory(host.ctx, policy, memoryInput.parse({
    action: 'legacy_forget', scope: 'session', scopeId: host.session.id, id: fact.id, version: memoryVersion(JSON.stringify(fact)),
  }), host.exec);
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  await waiting;
  policy.state.automatic = false; policy.maintenanceController.abort(); release('allowed-once');
  await rejected; assert.equal(host.facts()[0].state, 'active');
});
