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
let running = false, attempts = 0, executions = 0;
const ids = [], requests = new Map();
const records = [{ event: { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '原有上下文' }] } } }];
const connect = () => {
  const socket = new WebSocket('ws://127.0.0.1:18789/api/device/connect', {
    headers: { Authorization: `Bearer ${login.access_token}` },
  });
  socket.on('close', () => setTimeout(connect, 1000));
  socket.on('error', () => {});
  socket.on('message', raw => {
    const message = JSON.parse(raw.toString());
    if (message.type === 'ping') { socket.send(JSON.stringify({ type: 'pong' })); return; }
    if (message.type !== 'remote.call') return;
    const { method, args } = message.call;
    let value;
    if (method === 'list') value = { items: [{ sessionId: 'synthetic-session', title: '测试远程会话', running, updatedAt: Date.now() }] };
    else if (method === 'snapshot') value = { type: 'snapshot', records };
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
  response.end(JSON.stringify({ fixture: 'dogo-synthetic-v1', attempts, executions, ids, running }));
}).listen(18790, '127.0.0.1', connect);
