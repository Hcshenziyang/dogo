import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ScopedMemory, recordPath } from '../src/host/scoped-memory.mjs';
import { MemoryFiles } from '../src/host/memory-files.mjs';
import { PersonalMemory } from '../src/host/memory.mjs';
import { registerMemory, MEMORY_GUIDANCE } from '../src/memory-tools.mjs';
import { legacyMemory } from '../src/legacy-memory.mjs';
import { memoryInput } from '../src/host/scoped-memory.mjs';

const origin = { sessionId: 'session-fixture', seq: 42, callId: 'call-one' };
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'dogo-scoped-memory-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const files = new MemoryFiles(root);
  return { root, files, memory: new ScopedMemory(files) };
}
test('explicit scope routes records independently; links never cause implicit dual writes; persistence and CAS', async t => {
  const { root, files, memory } = await fixture(t);
  assert.throws(() => memory.execute({ action: 'create', text: 'missing scope' }, origin));
  assert.throws(() => memory.execute({ action: 'create', scope: 'personal', scopeId: 'wrong', text: 'x' }, origin));
  assert.throws(() => memory.execute({ action: 'create', scope: 'topic', text: 'missing ID' }, origin));
  const personal = memory.execute({ action: 'create', scope: 'personal', text: 'Research voice assistants', related: [{ scope: 'topic', scopeId: 'voice' }] }, origin);
  assert.equal(memory.entries().records.length, 1);
  const topic = memory.execute({ action: 'create', scope: 'topic', scopeId: 'voice', text: 'Source https://example.test, observed 2026-10-20' }, { ...origin, callId: 'topic' });
  for (const scope of ['project', 'session'])
    memory.execute({ action: 'create', scope, scopeId: 'same-id', text: scope }, { ...origin, callId: scope });
  assert.equal(memory.execute({ action: 'search', scope: 'personal' }).total, 1);
  assert.equal(memory.execute({ action: 'search', scope: 'topic', scopeId: 'different' }).total, 0);
  assert.equal(memory.execute({ action: 'search', scope: 'topic', scopeId: 'voice', query: 'example.test' }).total, 1);
  assert.deepEqual(memory.execute({ action: 'contexts', scope: 'topic' }).contexts, [{ scope: 'topic', scopeId: 'voice' }]);
  assert.throws(() => memory.execute({ action: 'read', scope: 'topic', scopeId: 'voice', id: personal.record.id }), /not found/);
  assert.throws(() => memory.execute({ action: 'update', scope: 'personal', id: personal.record.id, text: 'no version' }, origin));
  const updated = memory.execute({ action: 'update', scope: 'personal', id: personal.record.id, version: personal.version, text: 'Now studying voice assistants' }, { ...origin, seq: 50 });
  assert.deepEqual(updated.record.source, origin);
  assert.equal(updated.record.updatedSource.seq, 50);
  assert.throws(() => memory.execute({ action: 'delete', scope: 'personal', id: personal.record.id, version: personal.version }, origin), /changed/);
  const reopened = new ScopedMemory(new MemoryFiles(root));
  assert.equal(reopened.execute({ action: 'read', scope: 'personal', id: personal.record.id }).record.text, updated.record.text);
  const replay = memory.execute({ action: 'create', scope: 'topic', scopeId: 'voice', text: topic.record.text }, { ...origin, callId: 'topic' });
  assert.equal(replay.replayed, true); assert.equal(replay.record.id, topic.record.id);
  assert.throws(() => files.write(topic.path, JSON.stringify({ ...topic.record, scope: 'personal' }), files.read(topic.path)), /scopeId|path/);
  const result = memory.execute({ action: 'delete', scope: 'personal', id: personal.record.id, version: updated.version }, origin);
  assert.equal(result.historyRetained, true);
  assert.equal(memory.execute({ action: 'search', scope: 'personal' }).total, 0);
  assert.equal(memory.execute({ action: 'read', scope: 'topic', scopeId: 'voice', id: topic.record.id }).record.id, topic.record.id);
  assert.equal(files.read(recordPath(updated.record)), null);
});

test('invalid synced records are reported without preventing access to valid memories', async t => {
  const { memory, root } = await fixture(t);
  const good = memory.execute({ action: 'create', scope: 'personal', text: 'valid' }, origin);
  const bad = memory.execute({ action: 'create', scope: 'personal', text: 'broken' }, { ...origin, callId: 'bad' });
  await writeFile(path.join(root, bad.path), '{broken');
  const result = memory.execute({ action: 'search', scope: 'personal' });
  assert.equal(result.total, 1); assert.equal(result.records[0].id, good.record.id);
  assert.equal(result.errors[0].path, bad.path);
});

test('agent tools, settings and sync share files; automatic policy, queue and cancellation are enforced', async t => {
  const { root } = await fixture(t);
  const values = new Map();
  const engine = { directory: root, store: { value: (key, fallback) => values.get(key) ?? fallback, setValue: (key, value) => values.set(key, value) },
    dsh: {}, relay: {}, changed() {} };
  const memory = new PersonalMemory(engine); t.after(() => memory.close());
  assert.equal(memory.state.enabled, true); assert.equal(memory.state.automatic, true);
  const saved = await memory.recordAction({ action: 'create', scope: 'personal', text: 'shared' }, origin);
  assert.equal(saved.sync, 'waiting-for-connection');
  assert((await memory.action({ op: 'status' })).files.includes(saved.path));
  const raw = (await memory.action({ op: 'read', args: { path: saved.path } })).content;
  await memory.action({ op: 'write', args: { path: saved.path, base: raw, content: JSON.stringify({ ...saved.record, text: 'edited in settings' }) } });
  await assert.rejects(memory.recordAction({ action: 'update', scope: 'personal', id: saved.record.id, version: saved.version, text: 'stale' }, origin), /changed/);
  await memory.configure({ automatic: false, enabled: false });
  await assert.rejects(memory.recordAction({ action: 'create', scope: 'personal', text: 'disabled' }, origin), /disabled/);
  assert.equal((await memory.recordAction({ action: 'search', scope: 'personal' })).records[0].text, 'edited in settings');
  const reopened = new PersonalMemory(engine); assert.equal(reopened.state.enabled, false); assert.equal(reopened.state.automatic, false);
  await memory.configure({ automatic: true });
  const abort = new AbortController(); abort.abort();
  await assert.rejects(memory.recordAction({ action: 'create', scope: 'personal', text: 'aborted' }, origin, abort.signal), { name: 'AbortError' });
});

test('scope guidance reaches the prompt and tool schema; legacy tools are masked and reads expose versions', async t => {
  const { root } = await fixture(t);
  const engine = { directory: root, store: { value: (_k, fallback) => fallback }, dsh: {}, relay: {}, changed() {} };
  const memory = new PersonalMemory(engine); t.after(() => memory.close());
  const tools = new Map(), prompts = [], denied = [], disposers = [];
  let released = false;
  tools.set('memory_remember', { execute() { throw new Error('must not write legacy'); } });
  tools.set('memory_recall', { execute: async () => 'old fact' });
  tools.set('memory_profile', { execute: async () => 'old profile' });
  const agent = { session: { id: origin.sessionId, seq: origin.seq, header: { cwd: '/synthetic' } }, ctx: { tools: { restrict: ({ deny }) => { denied.push(...deny); return () => { released = true; }; } } } };
  const oldFact = { id: 'e91481cd-e6ae-449e-9f8e-9d8cdaf103b1', text: 'old fact', tags: [], workspacePath: '/synthetic', state: 'active', updatedAt: 0 };
  const ctx = { get: () => ({ get: () => ({ table: () => new Map([[oldFact.id, oldFact]]) }) }),
    tools: { get: name => tools.get(name), register: tool => tools.set(tool.name, tool) },
    on() {}, effect: install => disposers.push(install()), agents: { list: () => [agent] }, systemPrompt: { section: section => prompts.push(section) } };
  registerMemory(ctx, memory);
  assert(denied.includes('memory_remember')); assert(denied.includes('memory_recall'));
  const tool = tools.get('dogo_memory'), exec = { agent, callId: 'live', signal: new AbortController().signal };
  const saved = JSON.parse(await tool.execute({ action: 'create', scope: 'personal', text: 'Personal fixture' }, exec));
  assert.equal(saved.record.source.seq, 42);
  await memory.action({ op: 'write', args: { path: 'old-preferences.md', base: null, content: 'Legacy personal preference' } });
  const oldFiles = JSON.parse(await tool.execute({ action: 'legacy_read', scope: 'personal', query: 'Legacy' }, exec));
  assert.equal(oldFiles.files[0].path, 'old-preferences.md');
  const prompt = prompts[0].text({ agent });
  for (const scope of ['personal', 'topic', 'project', 'session']) assert(MEMORY_GUIDANCE.includes(scope));
  assert(prompt.includes('Personal fixture')); assert(prompt.includes(origin.sessionId));
  await assert.rejects(tool.execute({ action: 'legacy_read', scope: 'session', scopeId: 'other', query: 'old' }, exec), /current session/);
  const legacy = JSON.parse(await tool.execute({ action: 'legacy_read', scope: 'session', scopeId: origin.sessionId, query: 'old' }, exec));
  assert.equal(legacy.legacy, true); assert.equal(legacy.records[0].text, 'old fact');
  assert.match(legacy.records[0].version, /^[a-f0-9]{64}$/);
  for (const dispose of disposers) dispose();
  assert.equal(released, true, 'unloading the plugin releases legacy tool masks');
});

test('legacy file cleanup requires complete versioned reads, preserves backups and cannot cross into scoped records', async t => {
  const { root } = await fixture(t);
  const values = new Map();
  const engine = { directory: root, store: { value: (key, fallback) => values.get(key) ?? fallback, setValue: (key, value) => values.set(key, value) }, dsh: {}, relay: {}, changed() {} };
  const memory = new PersonalMemory(engine); t.after(() => memory.close());
  const exec = { signal: new AbortController().signal };
  const call = input => legacyMemory({}, memory, memoryInput.parse({ scope: 'personal', ...input }), exec);
  const text = 'Old fixture '.repeat(500);
  await memory.action({ op: 'write', args: { path: 'legacy.md', base: null, content: text } });
  const listed = await call({ action: 'legacy_read' });
  assert.equal(listed.files[0].truncated, true); assert.equal(listed.files[0].version, undefined);
  const read = await call({ action: 'legacy_read', path: 'legacy.md' });
  assert.equal(read.files[0].content, text); assert.equal(read.files[0].truncated, false);
  await assert.rejects(call({ action: 'legacy_forget', path: '../legacy.md', version: read.files[0].version }));
  await memory.configure({ automatic: false });
  assert.equal(memory.maintenanceController.signal.aborted, true);
  await assert.rejects(call({ action: 'legacy_forget', path: 'legacy.md', version: read.files[0].version }), /disabled/);
  await memory.configure({ automatic: true });
  assert.equal(memory.maintenanceController.signal.aborted, false);
  await memory.action({ op: 'write', args: { path: 'legacy.md', base: text, content: 'Changed after reading' } });
  await assert.rejects(call({ action: 'legacy_forget', path: 'legacy.md', version: read.files[0].version }), /changed/);
  const current = (await call({ action: 'legacy_read', path: 'legacy.md' })).files[0];
  const saved = await memory.recordAction({ action: 'create', scope: 'personal', text: 'Keep new record' }, origin);
  await assert.rejects(call({ action: 'legacy_forget', path: saved.path, version: saved.version }), /explicit scope/);
  const removed = await call({ action: 'legacy_forget', path: 'legacy.md', version: current.version });
  assert.equal(removed.deleted, true); assert.equal(removed.historyRetained, true);
  assert.equal(removed.sync, 'waiting-for-connection');
  assert.equal((await call({ action: 'legacy_read' })).total, 0);
  assert.equal((await memory.recordAction({ action: 'search', scope: 'personal' })).total, 1);
  const { readdir, readFile } = await import('node:fs/promises');
  const backups = path.join(memory.folder, '.dogo-sync/backups');
  const copies = await Promise.all((await readdir(backups)).map(file => readFile(path.join(backups, file), 'utf8')));
  assert(copies.some(value => JSON.parse(value).content === 'Changed after reading'));
});
