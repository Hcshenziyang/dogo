import test from 'node:test';
import assert from 'node:assert/strict';
import { checkReadiness } from '../src/host/readiness.mjs';

function fixture() {
  return { store: { settings: () => ({ endpoint: 'https://model.fixture/v1/', model: 'fixture' }) }, dsh: { ensure: async () => {}, request: async () => ({ ready: true, version: 'fixture', plugins: { memory: true, codex: true } }) }, hub: { policy: { autoExecute: false } }, capabilities: { policy: { computer: false, codex: false, sshHosts: [] } }, changed() {} };
}
test('readiness is a bounded metadata check, not a model generation or automatic permission grant', async () => {
  const engine = fixture(); let calls = 0;
  const value = await checkReadiness(engine, {}, async (url, options) => {
    calls++; assert.equal(url, 'https://model.fixture/v1/models'); assert.equal(options.redirect, 'error');
    return Response.json({ data: [{ id: 'fixture' }] });
  });
  assert.equal(calls, 1); assert(value.checks.find(c => c.id === 'model').ok);
  for (const id of ['screen', 'accessibility', 'unattended', 'computer-tool', 'codex-cli', 'ssh']) assert.equal(value.checks.find(c => c.id === id).ok, false);
  assert.equal(engine.readiness, value);
});
test('oversized model response is cancelled while reading and marked unavailable', async () => {
  let cancelled = false, pulls = 0;
  const value = await checkReadiness(fixture(), {}, async () => new Response(new ReadableStream({ pull(c) { pulls++; c.enqueue(new Uint8Array(256 * 1024)); }, cancel() { cancelled = true; } })));
  assert.equal(value.checks.find(c => c.id === 'model').ok, false);
  assert(cancelled); assert(pulls <= 7);
});
