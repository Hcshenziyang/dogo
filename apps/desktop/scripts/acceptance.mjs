// Explicit isolated manual acceptance app: no pairing, personal data or real model calls.
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { Engine } from '../../runtime/src/engine.mjs';

const require = createRequire(import.meta.url);
const reuse = process.argv[2];
if (reuse && (!path.isAbsolute(reuse) || !path.basename(reuse).startsWith('dogo-workspace-acceptance-') || path.dirname(reuse) !== path.resolve(tmpdir()))) throw new Error('Reuse only this script\'s isolated temporary directory');
const home = reuse ?? await mkdtemp(path.join(tmpdir(), 'dogo-workspace-acceptance-'));
// The packaged executable still receives an isolated profile and a synthetic model.
const packaged = process.env.DOGO_ACCEPTANCE_APP;
if (packaged) {
  if (!path.isAbsolute(packaged) || !packaged.endsWith('.app')) throw new Error('Use an absolute .app bundle');
  await access(path.join(packaged, 'Contents/MacOS/DogO'));
  await access(path.join(packaged, 'Contents/Resources/node/bin/node'));
}
let requests = 0;
const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/v1/models') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ data: [{ id: 'workspace-fixture' }] })); return; }
  let body = ''; for await (const chunk of req) body += chunk;
  const input = JSON.parse(body); requests++;
  const followup = input.messages.some(message => message.role === 'assistant' && JSON.stringify(message.content).includes('WORKSPACE_OK_827'));
  const slow = JSON.stringify(input.messages.at(-1)).includes('WAIT_WORKSPACE');
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const send = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: 'workspace-fixture', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
  send({ role: 'assistant', content: followup ? 'WORKSPACE_FOLLOWUP_OK_827' : 'WORKSPACE_OK_827' });
  const finish = () => { if (!res.destroyed) { send({}, 'stop'); res.end('data: [DONE]\n\n'); } };
  if (slow) { const timer = setTimeout(finish, 45000); res.on('close', () => clearTimeout(timer)); } else finish();
  console.log(JSON.stringify({ fixtureRequest: requests, followup, slow }));
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const engine = new Engine(path.join(home, 'local'));
engine.configure({ ...engine.store.settings(), endpoint: `http://127.0.0.1:${server.address().port}/v1`, model: 'workspace-fixture' });
await engine.close();
console.log(JSON.stringify({ isolatedUserData: home, paired: false, model: 'workspace-fixture' }));
const child = spawn(packaged ? path.join(packaged, 'Contents/MacOS/DogO') : require('electron'), packaged ? [] : [fileURLToPath(new URL('..', import.meta.url))], {
  stdio: 'inherit', env: { ...process.env, DOGO_NODE: packaged ? path.join(packaged, 'Contents/Resources/node/bin/node') : process.execPath, DOGO_USER_DATA_DIR: home, DOGO_DATA_DIR: path.join(home, 'local') },
});
child.on('exit', code => { server.closeAllConnections(); server.close(); process.exitCode = code ?? 1; });
process.on('SIGINT', () => child.kill('SIGINT'));
process.on('SIGTERM', () => child.kill('SIGTERM'));
