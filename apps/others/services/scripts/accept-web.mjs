// Explicit, loopback-only browser acceptance with a synthetic account/model and real DSH.
// Never loads production configuration, credentials, project files or model endpoints.
import http from 'node:http';
import { once } from 'node:events';
import { randomUUID, randomBytes } from 'node:crypto';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createService } from '../src/server.ts';
import { Engine } from '../../../runtime/src/engine.mjs';
if (!process.argv.includes('--run')) throw new Error('Pass --run to start the isolated browser acceptance fixture');
const directory = await mkdtemp(path.join(tmpdir(), 'dogo-web-acceptance-'));
const reservation = http.createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
const port = reservation.address().port, origin = `http://127.0.0.1:${port}`;
await new Promise(resolve => reservation.close(resolve));
const env = { DOGO_FIXTURE_MAC: randomBytes(36).toString('base64url') };
const service = createService({ port, publicOrigin: origin, database: path.join(directory, 'service.sqlite'),
  webRoot: fileURLToPath(new URL('../../../mobile/dist', import.meta.url)),
  devices: [{ id: 'mac', tokenEnv: 'DOGO_FIXTURE_MAC', memory: true }], mailboxes: { '/tasks/mac': 'mac' } }, env);
await service.listen();
const login = { username: 'fixture-owner', password: 'Synthetic browser fixture 731!', name: 'Fixture Mac', platform: 'mac', installationId: randomUUID() };
const owner = await service.account.setup(login, service.account.authenticate(env.DOGO_FIXTURE_MAC), 'fixture');
const principal = service.account.authenticate(owner.token);
// Auto-grants only this disposable fixture's newly logged-in browser, never production devices.
const grants = setInterval(() => {
  for (const d of service.account.devices(principal).devices) if (d.platform === 'web' && !d.revoked && !d.permissions.publishTo.length)
    service.account.updateDevice(principal, { id: d.id, name: d.name, memory: true, sendTo: ['mac'] });
}, 500);
let requests = 0;
const model = http.createServer(async (req, res) => {
  if (req.url === '/v1/models') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'fixture' }] })); return; }
  let body = ''; for await (const chunk of req) body += chunk;
  const input = JSON.parse(body); requests++;
  const followup = input.messages.some(m => m.role === 'assistant' && JSON.stringify(m.content).includes('WEB_DSH_FIXTURE_731'));
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const [delta, finish_reason] of [[{ role: 'assistant', content: followup ? 'WEB_DSH_FOLLOWUP_731' : 'WEB_DSH_FIXTURE_731' }, null], [{}, 'stop']])
    res.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
  res.end('data: [DONE]\n\n'); console.log(JSON.stringify({ syntheticModelRequest: requests, followup }));
});
model.listen(0, '127.0.0.1'); await once(model, 'listening');
const engine = new Engine(path.join(directory, 'desktop'));
engine.configure({ ...engine.store.settings(), endpoint: `http://127.0.0.1:${model.address().port}/v1`, model: 'fixture' });
engine.relay.fetcher = (url, options) => fetch(url.replace('https://fixture.invalid', origin), options);
await engine.hub.configure({ autoExecute: true });
const project = path.join(directory, 'synthetic-project'); await mkdir(project);
await engine.hub.register(project);
await engine.relay.connect({ version: 1, url: 'https://fixture.invalid', device: 'mac', token: env.DOGO_FIXTURE_MAC });
console.log(JSON.stringify({ origin, directory, username: login.username, password: login.password, syntheticOnly: true }));
let stopping = false;
async function stop() {
  if (stopping) return; stopping = true; clearInterval(grants);
  await engine.close(); await service.close(); model.closeAllConnections(); model.close();
}
process.on('SIGINT', () => void stop()); process.on('SIGTERM', () => void stop());
