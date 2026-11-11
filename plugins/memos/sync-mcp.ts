import { createServer, type Server } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import type { MemoService } from './service.js';
import type { Runtime } from '../shared/runtime.js';

type SyncControl = Pick<MemoService, 'control'>;
type LocalMcp = { url: string; token: string; close(): Promise<void> };

/** A loopback-only MCP endpoint delegates to the same local memo service as the UI. */
export async function startSyncMcp(
  service: SyncControl,
  loggedIn: () => boolean,
): Promise<LocalMcp> {
  const token = randomBytes(32).toString('base64url');
  const expected = Buffer.from('Bearer ' + token);
  const http: Server = createServer((req, res) => {
    const supplied = Buffer.from(req.headers.authorization || '');
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      res.writeHead(401).end();
      return;
    }
    if (req.headers.origin || !loggedIn()) {
      res.writeHead(403).end();
      return;
    }
    if (req.url !== '/mcp' || req.method !== 'POST') {
      res.writeHead(405).end();
      return;
    }
    const mcp = new McpServer({ name: 'dogo-memo-sync', version: '0.1.0' });
    mcp.registerTool(
      'sync_memos',
      {
        description:
          '查看本机备忘录同步状态，或请求立即开始与已登录的 DogO 账户同步。触发不代表同步已完成；冲突或失败需要查看返回状态。',
        inputSchema: { action: z.enum(['status', 'sync']).default('status') },
      },
      async ({ action }) => {
        if (!loggedIn())
          return { isError: true, content: [{ type: 'text', text: '请先登录 DogO。' }] };
        if (action === 'sync') await service.control('sync-now');
        const value = await service.control('sync-report');
        return {
          content: [
            { type: 'text', text: JSON.stringify({ ...value, requested: action === 'sync' }) },
          ],
        };
      },
    );
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.once('close', () => void mcp.close().catch(() => {}));
    void mcp
      .connect(transport)
      .then(() => transport.handleRequest(req, res))
      .catch(() => {
        if (!res.headersSent) res.writeHead(500).end();
        else res.destroy();
        void mcp.close().catch(() => {});
      });
  });
  http.on('error', () => {});
  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen(0, '127.0.0.1', () => {
      http.off('error', reject);
      resolve();
    });
  });
  const address = http.address();
  if (!address || typeof address === 'string') {
    http.close();
    throw Error('Unable to start local memo MCP server');
  }
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    token,
    close: () =>
      new Promise<void>((resolve, reject) => {
        http.close((error) => (error ? reject(error) : resolve()));
        http.closeAllConnections();
      }),
  };
}

/** Mount the official DSH MCP client only while a DogO account is logged in. */
export function installSyncMcp(
  ctx: any,
  service: SyncControl,
  runtime: Runtime,
  loadClient = () => import('@deepseek-ai/dsh-mcp-client'),
) {
  let stopped = false;
  let current: { server: LocalMcp; fiber: { dispose(): Promise<void> } } | undefined;
  let pending = Promise.resolve();

  const disposeCurrent = async () => {
    const value = current;
    current = undefined;
    if (!value) return;
    try {
      await value.fiber.dispose();
    } finally {
      await value.server.close();
    }
  };
  const reconcile = async () => {
    if (stopped || !runtime.api.state) return disposeCurrent();
    if (current) return;
    const client = await loadClient();
    if (stopped || !runtime.api.state) return;
    const server = await startSyncMcp(service, () => !!runtime.api.state && !stopped);
    if (stopped || !runtime.api.state) return server.close();
    let fiber: any;
    try {
      fiber = ctx.plugin(client, {
        serverName: 'dogo_memo',
        transport: 'streamable-http',
        url: server.url,
        headers: { Authorization: 'Bearer ' + server.token },
        failOnStartupError: true,
      });
      current = { server, fiber };
      await fiber;
      if (stopped || !runtime.api.state) await disposeCurrent();
    } catch (error) {
      if (current?.fiber === fiber) await disposeCurrent();
      else await server.close();
      throw error;
    }
  };
  const changed = () => {
    pending = pending.then(reconcile).catch(() => {
      ctx.logger?.warn?.('DogO 备忘录同步 MCP 暂时不可用。');
    });
  };
  runtime.api.changes.add(changed);
  changed();
  return async () => {
    stopped = true;
    runtime.api.changes.delete(changed);
    await pending;
    await disposeCurrent();
  };
}
