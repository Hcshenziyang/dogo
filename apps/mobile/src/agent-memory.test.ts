import test from 'node:test';
import assert from 'node:assert/strict';
import { PhoneMemoryMaintenance } from './agent-memory.ts';
import type { AgentTransport } from './agent.ts';

function fixture() {
  let disk: string | null = null, calls = 0;
  const conflict: any = { id: 'fixture', path: 'fixture.md', base: 'base', local: 'base\nlocal', remote: 'base\nremote', remoteVersion: 2, status: 'pending' };
  const operations: string[] = [];
  const config = { endpoint: 'https://model.fixture/v1', model: 'fixture', hasKey: false, mcp: [], skills: [], memoryMaintenance: true };
  const transport: AgentTransport = { status: async () => config, configure: async () => config, cancel: async () => {}, request: async () => {
    calls++; return { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'fixture', created: 1, model: 'fixture', choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify({ decision: 'merge', content: 'base\nlocal\nremote', reason: 'independent fixture facts' }) }, finish_reason: 'stop' }] }) };
  } };
  const storage = { get: async () => disk, set: async (s: string) => { disk = s; } };
  const memory = async ({ op, args = {} }: any) => {
    operations.push(op);
    if (op === 'status') return { enabled: true };
    if (op === 'policy') return { automatic: true, canMaintain: true };
    if (op === 'conflicts') return { conflicts: [conflict] };
    if (op === 'claim') { assert(disk?.includes(args.executionId)); conflict.status = 'analyzing'; conflict.claimedBy = 'phone'; conflict.executionId = args.executionId; }
    if (op === 'resolve') { assert.equal(args.version, 2); conflict.status = 'resolved'; conflict.content = args.content; }
    if (op === 'defer') { conflict.status = 'needs-human'; conflict.reason = args.reason; }
    return conflict;
  };
  return { transport, storage, memory, config, conflict, operations, calls: () => calls };
}

test('opt-in phone maintenance runs separately with durable claim, CAS and no repeat', async () => {
  const f = fixture(), runner = new PhoneMemoryMaintenance(f.transport, f.storage, f.memory, async () => 'phone');
  await runner.run(); assert.equal(f.conflict.status, 'resolved'); assert.equal(f.conflict.content, 'base\nlocal\nremote'); assert.equal(f.calls(), 1);
  await runner.run(); assert.equal(f.calls(), 1);
});
test('disabled maintenance does not even read personal conflicts; interrupted claim is deferred without model replay', async () => {
  const f = fixture(); f.config.memoryMaintenance = false;
  const runner = new PhoneMemoryMaintenance(f.transport, f.storage, f.memory, async () => 'phone'); await runner.run(); assert.equal(f.operations.length, 0);
  f.config.memoryMaintenance = true; f.conflict.status = 'analyzing'; f.conflict.claimedBy = 'phone';
  await f.storage.set(JSON.stringify({ fixture: 'previous-execution' })); await runner.run();
  assert.equal(f.conflict.status, 'needs-human'); assert.equal(f.calls(), 0);
});
test('backgrounding during configuration prevents a later claim and model request', async () => {
  const f = fixture(); let release!: () => void;
  f.transport.status = () => new Promise(resolve => { release = () => resolve(f.config); });
  const runner = new PhoneMemoryMaintenance(f.transport, f.storage, f.memory, async () => 'phone');
  const job = runner.run(); runner.stop(); release(); await assert.rejects(job, /abort/i); assert.equal(f.operations.length, 0); assert.equal(f.calls(), 0);
});
