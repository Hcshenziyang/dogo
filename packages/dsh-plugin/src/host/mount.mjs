import { HostServices } from './services.mjs';
import { NativeCapabilities } from './native-client.mjs';
import { acquireData } from './data-lease.mjs';
import { dispatch } from './dispatch.mjs';
import { CLIENT_METHODS, HOST_PROTOCOL, DSH_VERSION, hostRequest } from '@dogo/contracts/host';

export async function mountHost(ctx, dsh) {
  if (process.env.DOGO_HOST_SERVICES !== '1') return null;
  const directory = process.env.DOGO_DATA_DIR;
  if (!directory) throw new Error('DogO plugin data directory is required');
  const release = await acquireData(directory);
  let host;
  try { host = new HostServices(directory, { dsh, capabilities: new NativeCapabilities() }); }
  catch (error) { await release(); throw error; }
  let lease = 0, controls = Promise.resolve(), stopping = false;
  const serialized = new Set(['connectRelay', 'disconnectRelay', 'remotePolicy', 'registerProject', 'updateProject', 'configure', 'shutdown']);
  const heartbeat = () => { lease = Date.now() + 30000; };
  const execute = async input => {
    const request = hostRequest.parse(input);
    if (request.method === 'heartbeat') heartbeat();
    if (request.method === 'connectRelay' && Date.now() >= lease) throw new Error('客户端连接已过期，请重新连接');
    if (!serialized.has(request.method)) return dispatch(host, request);
    const next = controls.then(() => dispatch(host, request)); controls = next.catch(() => {}); return next;
  };
  const timer = setInterval(() => {
    if (!stopping && host.relay.key && Date.now() >= lease) {
      stopping = true;
      void execute({ method: 'disconnectRelay' }).catch(() => {}).finally(() => { stopping = false; });
    }
  }, 1000);
  timer.unref?.();
  // Dispose business consumers before DSH's session services and their durable receipts.
  ctx.effect(() => async () => { clearInterval(timer); await controls; try { await host.close(); } finally { await release(); } });
  const reply = (res, status, value) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)); };
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/dogo-client', handler: async (req, res) => {
    const admission = ctx.connection.admit(req);
    if ('rejection' in admission) { reply(res, admission.rejection, { error: 'Forbidden' }); return; }
    // Require JSON POST; no GET mutation or cross-origin form submissions.
    if (req.method !== 'POST' || !req.headers['content-type']?.startsWith('application/json')) { reply(res, 405, { error: 'JSON POST required' }); return; }
    try {
      const input = hostRequest.parse(await readJson(req));
      if (!CLIENT_METHODS.has(input.method)) { reply(res, 403, { error: '此操作需要原生客户端确认' }); return; }
      reply(res, 200, { result: await execute(input) });
    } catch (error) { reply(res, 400, { error: String(error.message).slice(0, 1000) }); }
  } }));
  return {
    host, execute,
    handshake: () => ({ protocol: HOST_PROTOCOL, dshVersion: DSH_VERSION, pid: process.pid, generation: dsh.generation, services: true }),
  };
}
export async function readJson(req, limit = 33 * 1024 * 1024) {
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > limit) throw new Error('请求过大'); chunks.push(chunk); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
