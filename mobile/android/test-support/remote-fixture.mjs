// Synthetic desktop for the disposable-emulator integration test. No user data is used.
import { createRequire } from 'node:module';
import { createServer } from 'node:http';

const require = createRequire(new URL('../../../plugins/package.json', import.meta.url));
const WebSocket = require('ws');
const origin = 'http://127.0.0.1:18789';
const password = 'synthetic-test-password';
const post = async (path, body) => {
  const response = await fetch(origin + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!response.ok) throw Error(`${path}: ${response.status}`);
  return response.json();
};
await post('/api/auth/register', { username: 'synthetic-user', password, invite_code: 'synthetic-invite' });
const login = await post('/api/auth/login', {
  username: 'synthetic-user', password, device_id: 'synthetic-mac', device_name: 'Synthetic Mac', device_kind: 'desktop',
});
let running = false, attempts = 0, executions = 0, modelChanges = 0, connected = false;
let createAttempts = 0, createExecutions = 0;
let selection = { provider: 'fixture-provider', model: 'fixture-main', reasoningEffort: 'low' };
const ids = [], requests = new Map(), createIds = [], created = new Map();
const approvals = new Map([
  ['approval-allow-session', { id: 'approval-allow', toolName: 'bash', reason: '合成测试：允许本次操作', arguments: '{"command":"printf synthetic-allow"}', detailAvailable: true }],
  ['approval-reject-session', { id: 'approval-reject', toolName: 'bash', reason: '合成测试：拒绝本次操作', arguments: '{"command":"printf synthetic-reject"}', detailAvailable: true }],
]);
const approvalOutcomes = [];
const records = [
  { event: { seq: 1, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '原有上下文' }] } } },
  { event: { seq: 2, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '**加粗**\n' + '这是很长的回复，用于验证折叠和展开。\n'.repeat(24) }] } } } },
  { event: { seq: 3, type: 'tool/call', data: { name: 'synthetic-tool' } } },
  { event: { seq: 4, type: 'tool/result', data: { result: 'synthetic-tool-result' } } },
];
const connect = () => {
  const socket = new WebSocket('ws://127.0.0.1:18789/api/device/connect', {
    headers: { Authorization: `Bearer ${login.access_token}` },
  });
  socket.on('open', () => { connected = true; });
  socket.on('close', () => { connected = false; setTimeout(connect, 1000); });
  socket.on('error', () => {});
  socket.on('message', raw => {
    const message = JSON.parse(raw.toString());
    if (message.type === 'ping') { socket.send(JSON.stringify({ type: 'pong' })); return; }
    if (message.type !== 'remote.call') return;
    const { method, args } = message.call;
    let value;
    if (method === 'list') value = { items: [
      { sessionId: 'synthetic-session', title: '测试远程会话', running, updatedAt: Date.now() },
      { sessionId: 'approval-allow-session', title: '审批允许测试', running: approvals.has('approval-allow-session'), updatedAt: Date.now() },
      { sessionId: 'approval-reject-session', title: '审批拒绝测试', running: approvals.has('approval-reject-session'), updatedAt: Date.now() },
      { sessionId: 'archived-session', title: '归档测试会话', running: false, updatedAt: Date.now() },
      ...Array.from(created.values(), entry => ({ sessionId: entry.sessionId, title: '新会话', running: false, updatedAt: Date.now() })),
    ] };
    else if (method === 'workspaces') value = { archivedSessionIds: ['archived-session'], items: [
      { workspaceId: 'project-1', title: '测试项目', sessionIds: ['synthetic-session'] },
      { workspaceId: 'empty-project', title: '空项目', sessionIds: Array.from(created.values()).filter(entry => entry.workspaceId === 'empty-project').map(entry => entry.sessionId) },
    ] };
    else if (method === 'create') {
      createAttempts++;
      createIds.push(args.sessionId);
      const previous = created.get(args.sessionId);
      if (previous && JSON.stringify(previous) !== JSON.stringify(args)) throw Error('Create retry payload changed');
      if (!previous) {
        created.set(args.sessionId, args);
        createExecutions++;
        socket.close(); // The computer creates the session, but the first reply is lost.
        return;
      }
      value = { sessionId: args.sessionId };
    }
    else if (method === 'models') value = { default: selection, groups: [{ id: 'fixture-provider', name: 'Synthetic', models: [
      { id: 'fixture-main', name: 'Fixture Main', reasoning: { defaultEffort: 'low', efforts: [{ id: 'low', name: '低' }, { id: 'high', name: '高' }] } },
      { id: 'fixture-alt', name: 'Fixture Alt', reasoning: { defaultEffort: 'low', efforts: [{ id: 'low', name: '低' }, { id: 'high', name: '高' }] } },
    ] }], failures: [] };
    else if (method === 'selectModel') {
      selection = { provider: args.provider, model: args.model, ...(args.reasoningEffort ? { reasoningEffort: args.reasoningEffort } : {}) };
      modelChanges++;
      value = { selected: selection };
    }
    else if (method === 'snapshot') value = { type: 'snapshot', records: args.sessionId === 'synthetic-session' ? records : [], dogoApprovals: { available: true, items: approvals.has(args.sessionId) ? [approvals.get(args.sessionId)] : [] }, projections: { values: { modelSelection: { next: selection } } } };
    else if (method === 'respondApproval') {
      const pending = approvals.get(args.sessionId);
      if (!pending || pending.id !== args.approvalId || !['allowed-once', 'rejected'].includes(args.decision)) {
        socket.send(JSON.stringify({ type: 'remote.result', id: message.id, ok: false, error: 'approval unavailable' }));
        return;
      }
      approvals.delete(args.sessionId);
      approvalOutcomes.push({ sessionId: args.sessionId, decision: args.decision });
      value = { status: 'resolved', outcome: args.decision };
    }
    else if (method === 'prompt') {
      attempts++;
      ids.push(args.requestId);
      const previous = requests.get(args.requestId);
      if (previous && JSON.stringify(previous) !== JSON.stringify(args)) throw Error('Retry payload changed');
      if (!previous) {
        requests.set(args.requestId, args);
        executions++;
        running = true;
        records.push({ event: { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: args.text }] } } });
        setTimeout(() => {
          records.push({ event: { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '测试已完成' }] } } } });
          running = false;
        }, 2500);
        socket.close(); // Simulate the response disappearing after the computer accepted the message.
        return;
      }
      value = { accepted: true };
    } else throw Error(`Unexpected method: ${method}`);
    socket.send(JSON.stringify({ type: 'remote.result', id: message.id, ok: true, value }));
  });
};
createServer((_request, response) => {
  response.writeHead(200, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify({ fixture: 'dogo-synthetic-v1', attempts, executions, ids, running, selection, modelChanges,
    connected, createAttempts, createExecutions, createIds, created: Array.from(created.values()), approvalOutcomes }));
}).listen(18790, '127.0.0.1', connect);
