import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ZodError } from 'zod';
import { configSchema, createTaskSchema, claimSchema, progressSchema, finishSchema, memoryPath, memoryWriteSchema, ServiceError } from './schema.ts';
import type { Device } from './schema.ts';
import { Store } from './store.ts';
import { createMcp } from './mcp.ts';
import { Hub } from './hub.ts';
import { MemoryService } from './memory.ts';
import { AccountService } from './auth.ts';
import type { Principal } from './auth.ts';
import { serveWeb } from './web.ts';

export const digest = (content: string | null) => content === null ? null : createHash('sha256').update(content).digest('hex');

async function body(req: IncomingMessage): Promise<unknown> {
  if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json') throw new ServiceError(415, 'Expected application/json');
  if (Number(req.headers['content-length'] ?? 0) > 1024 * 1024) {
    req.resume();
    throw new ServiceError(413, 'Request body exceeds 1 MiB');
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > 1024 * 1024) { req.resume(); throw new ServiceError(413, 'Request body exceeds 1 MiB'); }
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new ServiceError(400, 'Invalid JSON'); }
}

function cursor(value: string | null) {
  if (value === null) return 0;
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new ServiceError(400, 'Invalid cursor');
  return Number(value);
}

function json(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(value));
}

export function createService(input: unknown, env: NodeJS.ProcessEnv = process.env, now = Date.now) {
  const config = configSchema.parse(input);
  const identities = config.devices.map(device => {
    const token = env[device.tokenEnv];
    if (!token || token.length < 32) throw new Error(`Set ${device.tokenEnv} to a unique random token of at least 32 characters`);
    return { device, token };
  });
  if (new Set(identities.map(i => digest(i.token))).size !== identities.length) throw new Error('Device tokens must be unique');
  const store = new Store(config, now);
  const account = new AccountService(store, identities);
  const hub = new Hub(store);
  const memory = new MemoryService(store);
  const streams = new Set<ServerResponse>();
  const counts = new Map<string, number>();
  const enabled = (service: 'tasks' | 'memory') => {
    if (!config.services.includes(service)) throw new ServiceError(404, 'Service disabled');
  };
  const publicOrigin = config.publicOrigin ? new URL(config.publicOrigin).origin : undefined;
  const secureCookie = publicOrigin?.startsWith('https:') ?? true;
  const cookieName = secureCookie ? '__Host-dogo-session' : 'dogo-dev-session';
  const checkRequest = (req: IncomingMessage) => {
    const host = new URL(`http://${req.headers.host ?? ''}`).hostname;
    if (!config.allowedHosts.includes(host)) throw new ServiceError(403, 'Host not allowed');
    if (req.headers.origin && (!publicOrigin || req.headers.origin !== publicOrigin)) throw new ServiceError(403, 'Browser origin not allowed');
    if (req.headers['sec-fetch-site'] === 'cross-site') throw new ServiceError(403, 'Cross-site request blocked');
  };
  const principal = (req: IncomingMessage): Principal => {
    checkRequest(req);
    const authorization = req.headers.authorization;
    if (authorization) {
      if (req.headers.origin) throw new ServiceError(403, 'Browser uses an HttpOnly account session, not a device token');
      if (!authorization.startsWith('Bearer ')) throw new ServiceError(401, 'Bearer token required');
      return account.authenticate(authorization.slice(7));
    }
    const token = req.headers.cookie?.split(';').map(v => v.trim()).find(v => v.startsWith(cookieName + '='))?.slice(cookieName.length + 1);
    if (!token || !publicOrigin) throw new ServiceError(401, 'Sign in required');
    const user = account.authenticate(token, true);
    if (!['GET', 'HEAD'].includes(req.method ?? 'GET')) {
      if (req.headers.origin !== publicOrigin) throw new ServiceError(403, 'Same-origin request required');
      account.checkCsrf(user, req.headers['x-dogo-csrf'] as string | undefined);
    }
    return user;
  };
  const authenticate = (req: IncomingMessage): Device => principal(req).device;
  const setCookie = (res: ServerResponse, token: string, expired = false) => res.setHeader('Set-Cookie',
    `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; ${secureCookie ? 'Secure; ' : ''}Max-Age=${expired ? 0 : 7 * 86400}`);

  const server = createServer(async (req, res) => {
    try {
      checkRequest(req);
      const url = new URL(req.url ?? '/', 'http://localhost');
      const method = req.method ?? 'GET';
      const path = url.pathname;
      if (publicOrigin && config.webRoot && await serveWeb(config.webRoot, path, method, res)) return;
      if (path === '/v3/auth/status' && method === 'GET') return json(res, 200, account.status());
      if (path === '/v3/auth/login' && method === 'POST') {
        let migration: Principal | undefined;
        if (req.headers.authorization) {
          try { migration = principal(req); }
          catch (error) { if (!(error instanceof ServiceError) || error.status !== 401) throw error; }
        }
        const login = await account.login(await body(req), req.socket.remoteAddress ?? 'unknown', !!req.headers.origin, migration);
        if (req.headers.origin) { setCookie(res, login.token); const { token: _, ...safe } = login; return json(res, 200, safe); }
        return json(res, 200, login);
      }
      if (path === '/v3/auth/recover' && method === 'POST') return json(res, 200, await account.reset(await body(req), req.socket.remoteAddress ?? 'unknown'));
      const user = principal(req), device = user.device;
      if (path.startsWith('/v3/auth/')) {
        if (path === '/v3/auth/setup' && method === 'POST') return json(res, 200, await account.setup(await body(req), user, req.socket.remoteAddress ?? 'unknown'));
        if (path === '/v3/auth/me' && method === 'GET') return json(res, 200, account.status(user));
        if (path === '/v3/auth/devices' && method === 'GET') return json(res, 200, account.devices(user));
        if (path === '/v3/auth/device' && method === 'POST') return json(res, 200, account.updateDevice(user, await body(req)));
        if (path === '/v3/auth/revoke' && method === 'POST') return json(res, 200, account.revoke(user, await body(req)));
        if (path === '/v3/auth/disable-legacy' && method === 'POST') return json(res, 200, account.disableLegacy(user));
        if (path === '/v3/auth/password' && method === 'POST') return json(res, 200, await account.changePassword(user, await body(req)));
        if (path === '/v3/auth/logout' && method === 'POST') { const value = account.logout(user); if (user.session?.browser) setCookie(res, '', true); return json(res, 200, value); }
      }
      if (path === '/v1/identity' && method === 'GET') return json(res, 200, { device: device.id, services: config.services, protocol: 2, account: 'personal' });
      if (path === '/v2/hub' && method === 'POST') {
        enabled('tasks');
        const input = await body(req) as { op?: unknown; args?: unknown };
        if (!input || typeof input.op !== 'string') throw new ServiceError(400, 'Operation required');
        return json(res, 200, hub.execute(device, input.op, input.args));
      }
      if (path === '/v2/memory' && method === 'POST') {
        const input = await body(req) as { op?: unknown; args?: unknown };
        if (!input || typeof input.op !== 'string') throw new ServiceError(400, 'Operation required');
        return json(res, 200, memory.execute(device, input.op, input.args));
      }
      if (path === '/v1/heartbeat' && method === 'POST') return json(res, 200, store.heartbeat(device));
      if (path === '/v1/events' && method === 'GET') {
        const after = cursor(url.searchParams.get('after'));
        const events = store.events(device, after);
        return json(res, 200, { events, nextCursor: events.at(-1)?.seq ?? after });
      }
      if (path === '/v1/events/stream' && method === 'GET') {
        let after = cursor(url.searchParams.get('after') ?? (req.headers['last-event-id'] as string | undefined) ?? null);
        if ((counts.get(device.id) ?? 0) >= 4) throw new ServiceError(429, 'At most four event streams per device');
        counts.set(device.id, (counts.get(device.id) ?? 0) + 1);
        streams.add(res);
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
        res.write('retry: 2000\n\n');
        const pump = () => {
          try {
            // Revocation takes effect for an already open stream, not just new requests.
            const events = store.events(authenticate(req), after);
            for (const event of events) {
              after = event.seq;
              if (!res.write(`id: ${event.seq}\nevent: change\ndata: ${JSON.stringify(event)}\n\n`)) {
                // Slow clients reconnect with their own last processed cursor; nothing is removed from the journal.
                res.end();
                return;
              }
            }
            res.write(': keepalive\n\n');
          } catch { res.destroy(); }
        };
        const timer = setInterval(pump, 1000);
        res.once('close', () => {
          clearInterval(timer);
          streams.delete(res);
          counts.set(device.id, (counts.get(device.id) ?? 1) - 1);
        });
        pump();
        return;
      }
      if (path === '/mcp') {
        enabled('tasks');
        if (method !== 'POST') { res.setHeader('Allow', 'POST'); return json(res, 405, { error: 'Use MCP Streamable HTTP POST' }); }
        const input = await body(req);
        const mcp = createMcp(store, device, hub);
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
        try {
          await mcp.connect(transport);
          await transport.handleRequest(req, res, input);
        } finally { await mcp.close(); }
        return;
      }
      if (path.startsWith('/v1/tasks')) {
        enabled('tasks');
        if (path === '/v1/tasks' && method === 'POST') return json(res, 200, store.create(device, createTaskSchema.parse(await body(req))));
        if (path === '/v1/tasks' && method === 'GET') return json(res, 200, store.tasks(device, cursor(url.searchParams.get('after'))));
        const match = /^\/v1\/tasks\/([a-zA-Z0-9_-]+)(?:\/(claim|progress|finish))?$/.exec(path);
        if (match && !match[2] && method === 'GET') return json(res, 200, store.task(device, match[1]));
        if (match && method === 'POST') {
          const value = await body(req);
          if (match[2] === 'claim') return json(res, 200, store.claim(device, match[1], claimSchema.parse(value).executionId));
          if (match[2] === 'progress') {
            const input = progressSchema.parse(value);
            return json(res, 200, store.progress(device, match[1], input.executionId, input.message));
          }
          if (match[2] === 'finish') return json(res, 200, store.finish(device, match[1], finishSchema.parse(value)));
        }
      }
      if (path.startsWith('/v1/memory')) {
        enabled('memory');
        if (path === '/v1/memory' && method === 'GET') {
          const files = store.memoryFiles(device).map(({ content, ...file }) => ({ ...file, hash: digest(content) }));
          return json(res, 200, { files });
        }
        if (path === '/v1/memory/file' && method === 'GET') {
          const file = store.memoryFile(device, memoryPath.parse(url.searchParams.get('path')));
          if (!file) throw new ServiceError(404, 'Memory file not found');
          return json(res, 200, file);
        }
        if (path === '/v1/memory/file' && method === 'PUT') {
          const input = memoryWriteSchema.parse(await body(req));
          return json(res, 200, store.writeMemory(device, input.path, input.baseVersion, input.content));
        }
      }
      throw new ServiceError(404, 'Route not found');
    } catch (error) {
      if (res.headersSent) { res.destroy(); return; }
      const status = error instanceof ServiceError ? error.status : error instanceof ZodError ? 400 : 500;
      const message = error instanceof ServiceError ? error.message : error instanceof ZodError ? 'Invalid request fields' : 'Internal service error';
      json(res, status, { error: message });
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  return {
    store, hub, memory, account, server, config,
    async listen() {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(config.port, config.host, () => { server.off('error', reject); resolve(); });
      });
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing server address');
      return `http://${config.host === '::1' ? '[::1]' : config.host}:${address.port}`;
    },
    async close() {
      for (const res of streams) res.destroy();
      await new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
        server.closeIdleConnections();
      });
      store.close();
    },
  };
}
