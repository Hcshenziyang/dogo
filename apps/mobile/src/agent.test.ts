import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { tool } from 'ai';
import { z } from 'zod';
import { MobileAgent, agentFetch, type AgentTransport, type AgentConfig } from './agent.ts';

const config: AgentConfig = { endpoint: 'https://model.fixture/v1', model: 'fixture', hasKey: true, mcp: [], skills: [] };
const reply = (message: unknown, finish = 'stop') => ({ status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'fixture-response', created: 1, model: 'fixture', choices: [{ index: 0, message, finish_reason: finish }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }) });
const waitFor = async (check: () => unknown) => { for (let n = 0; n < 150; n++) { if (check()) return; await delay(10); } throw new Error('fixture timeout'); };
function fixture(request: AgentTransport['request'], settings = config) {
  let value: string | null = null;
  const saved: string[] = [];
  const transport: AgentTransport = { status: async () => settings, configure: async () => settings, request, cancel: async () => {} };
  const storage = { get: async () => value, set: async (text: string) => { value = text; saved.push(text); } };
  return { transport, storage, saved };
}

test('real AI SDK tool loop persists approval before execution and final result; no API keys in JS', async () => {
  let calls = 0, executions = 0;
  const f = fixture(async input => {
    assert.equal(input.target, 'model'); assert.equal(input.url, config.endpoint + '/chat/completions'); assert(!('authorization' in input.headers));
    const body = JSON.parse(input.body); assert.equal(body.model, 'fixture'); assert(!body.stream); calls++;
    return calls === 1 ? reply({ role: 'assistant', content: null, tool_calls: [{ id: 'call-fixture', type: 'function', function: { name: 'sum', arguments: '{"a":2,"b":3}' } }] }, 'tool_calls') : reply({ role: 'assistant', content: '结果是 5' });
  });
  const agent = new MobileAgent(f.transport, f.storage, () => ({ sum: tool({ description: 'synthetic sum', inputSchema: z.object({ a: z.number(), b: z.number() }), execute: async ({ a, b }) => { executions++; assert(f.saved.some(s => s.includes('executing'))); return a + b; } }) }));
  const id = await agent.create(); await agent.draft(id, '计算 fixture'); const job = agent.send(id);
  await waitFor(() => agent.snapshot().approval); assert.equal(executions, 0); agent.answer(agent.snapshot().approval!.id, true); await job;
  assert.equal(calls, 2); assert.equal(executions, 1); assert.equal(agent.snapshot().chats[0].state, 'idle');
  assert(agent.snapshot().chats[0].messages.some(m => m.role === 'tool'));
  const restored = new MobileAgent(f.transport, f.storage); await restored.load(); assert(restored.export().includes('结果是 5')); assert(!restored.export().includes('apiKey'));
});

test('denying or stopping an approval never executes the tool; restart never replays', async () => {
  let executions = 0, calls = 0;
  const f = fixture(async () => ++calls % 2 ? reply({ role: 'assistant', content: null, tool_calls: [{ id: 'call-deny', type: 'function', function: { name: 'change', arguments: '{}' } }] }, 'tool_calls') : reply({ role: 'assistant', content: '未执行' }));
  const agent = new MobileAgent(f.transport, f.storage, () => ({ change: tool({ inputSchema: z.object({}), execute: async () => { executions++; return 'changed'; } }) }));
  const id = await agent.create(); await agent.draft(id, 'fixture'); const first = agent.send(id); await waitFor(() => agent.snapshot().approval); agent.answer(agent.snapshot().approval!.id, false); await first;
  assert.equal(executions, 0); assert(agent.export().includes('未执行'));
  await agent.draft(id, 'fixture again'); const second = agent.send(id); await waitFor(() => agent.snapshot().approval);
  const restart = new MobileAgent(f.transport, { get: f.storage.get, set: async () => {} }); await restart.load();
  assert.equal(restart.snapshot().chats[0].state, 'interrupted'); assert(restart.export().includes('unknown'));
  agent.stop(); await second; assert.equal(executions, 0); assert.equal(agent.snapshot().chats[0].state, 'interrupted');
});

test('native fetch cancellation rejects promptly even if a native socket is unresponsive', async () => {
  let cancelled = 0;
  const f = fixture(() => new Promise(() => {})); f.transport.cancel = async () => { cancelled++; };
  const controller = new AbortController();
  const pending = agentFetch(f.transport, 'model', controller.signal)('https://model.fixture/v1/chat/completions', { method: 'POST', body: '{}' });
  controller.abort(); await assert.rejects(pending, /停止/); assert.equal(cancelled, 1);
});

test('SDK MCP request-response discovery and approved execution use configured native target', async t => {
  let modelCalls = 0, toolCalls = 0;
  const f = fixture(async input => {
    if (input.target === 'model') return ++modelCalls === 1 ? reply({ role: 'assistant', content: null, tool_calls: [{ id: 'call-mcp', type: 'function', function: { name: 'mcp_fixture_ping', arguments: '{}' } }] }, 'tool_calls') : reply({ role: 'assistant', content: 'MCP fixture done' });
    assert.equal(input.target, 'fixture'); assert.equal(input.url, 'https://tools.fixture/mcp');
    if (input.method === 'GET') return { status: 405, headers: {}, body: '' };
    if (input.method === 'DELETE') return { status: 204, headers: {}, body: '' };
    const body = JSON.parse(input.body);
    if (body.id === undefined) return { status: 202, headers: {}, body: '' };
    if (body.method === 'server/discover') return { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'Method not found' } }) };
    const result = body.method === 'initialize' ? { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } } : body.method === 'tools/list' ? { tools: [{ name: 'ping', description: 'fixture', inputSchema: { type: 'object', properties: {} } }] } : (toolCalls++, { content: [{ type: 'text', text: 'PONG' }] });
    return { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: body.id, result }) };
  }, { ...config, mcp: [{ id: 'fixture', name: 'fixture', url: 'https://tools.fixture/mcp', hasKey: true, enabled: true }] });
  const agent = new MobileAgent(f.transport, f.storage); t.after(() => agent.stop()); const id = await agent.create(); await agent.draft(id, 'ping fixture'); const job = agent.send(id);
  await waitFor(() => agent.snapshot().approval || agent.snapshot().chats[0].state === 'failed');
  if (!agent.snapshot().approval) t.diagnostic(agent.snapshot().error);
  assert(agent.snapshot().approval, agent.snapshot().error); assert.equal(toolCalls, 0); agent.answer(agent.snapshot().approval!.id, true); await job;
  assert.equal(toolCalls, 1); assert.equal(agent.snapshot().chats[0].state, 'idle');
});

test('compression keeps full history and records summary; output limit is not success', async () => {
  let calls = 0;
  const f = fixture(async () => ++calls === 1 ? reply({ role: 'assistant', content: 'SUMMARY_FIXTURE' }) : reply({ role: 'assistant', content: 'partial' }, 'length'));
  await f.storage.set(JSON.stringify({ version: 1, selected: 'fixture', chats: [{ id: 'fixture', title: 'fixture', draft: '继续', state: 'idle', summarized: 0, summary: '', entries: [], messages: [{ role: 'user', content: 'x'.repeat(49000) }, { role: 'assistant', content: 'previous result' }] }] }));
  const agent = new MobileAgent(f.transport, f.storage); await agent.send('fixture');
  const chat = agent.snapshot().chats[0]; assert.equal(calls, 2); assert.equal(chat.summary, 'SUMMARY_FIXTURE'); assert.equal(chat.summarized, 2); assert.equal(chat.state, 'limited');
  assert(agent.export().includes('x'.repeat(49000))); assert(agent.export().includes('不代表任务完成'));
});

test('double-send cannot start duplicate turns', async () => {
  const f = fixture(async () => reply({ role: 'assistant', content: 'done' }));
  const agent = new MobileAgent(f.transport, f.storage); const id = await agent.create(); await agent.draft(id, 'one');
  const result = await Promise.allSettled([agent.send(id), agent.send(id)]);
  assert.equal(result.filter(r => r.status === 'rejected').length, 1); assert.equal(agent.snapshot().chats[0].entries.filter(e => e.role === 'user').length, 1);
});

test('an interrupted tool result remains uncertain across restart and is never replayed', async () => {
  let calls = 0, executions = 0;
  const f = fixture(async () => ++calls === 1 ? reply({ role: 'assistant', content: null, tool_calls: [{ id: 'call-failure', type: 'function', function: { name: 'change', arguments: '{}' } }] }, 'tool_calls') : reply({ role: 'assistant', content: '请核对执行结果' }));
  const agent = new MobileAgent(f.transport, f.storage, () => ({ change: tool({ inputSchema: z.object({}), execute: async (): Promise<string> => { executions++; throw new Error('connection lost after sending'); } }) }));
  const id = await agent.create(); await agent.draft(id, 'fixture'); const pending = agent.send(id);
  await waitFor(() => agent.snapshot().approval); agent.answer(agent.snapshot().approval!.id, true); await pending;
  assert.equal(executions, 1); assert(agent.export().includes('unknown'));
  const restored = new MobileAgent(f.transport, f.storage); await restored.load();
  assert(restored.export().includes('unknown')); assert.equal(executions, 1);
});
