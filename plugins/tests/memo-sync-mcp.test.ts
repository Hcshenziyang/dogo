import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { describe, expect, it, vi } from 'vitest';
import { installSyncMcp, startSyncMcp } from '../memos/sync-mcp.js';

describe('local memo synchronization MCP', () => {
  it('exposes real MCP status and trigger calls only to an authenticated local client', async () => {
    let loggedIn = true;
    let phase = 'ready';
    const control = vi.fn(async (method: string) => {
      if (method === 'sync-now') phase = 'syncing';
      return { phase, last_success: 123, error: '', pending_count: 1, conflict_count: 2 };
    });
    const server = await startSyncMcp({ control }, () => loggedIn);
    const client = new Client({ name: 'test', version: '1' });
    try {
      const unauthorized = await fetch(server.url, { method: 'POST' });
      expect(unauthorized.status).toBe(401);
      await client.connect(
        new StreamableHTTPClientTransport(new URL(server.url), {
          requestInit: { headers: { Authorization: 'Bearer ' + server.token } },
        }),
      );
      expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(['sync_memos']);
      const status = await client.callTool({ name: 'sync_memos', arguments: { action: 'status' } });
      expect(JSON.parse((status.content as any)[0].text)).toMatchObject({
        phase: 'ready',
        requested: false,
        pending_count: 1,
        conflict_count: 2,
      });
      const sync = await client.callTool({ name: 'sync_memos', arguments: { action: 'sync' } });
      expect(JSON.parse((sync.content as any)[0].text)).toMatchObject({
        phase: 'syncing',
        requested: true,
      });
      expect(control.mock.calls.map(([method]) => method)).toEqual([
        'sync-report',
        'sync-now',
        'sync-report',
      ]);
      loggedIn = false;
      await expect(
        client.callTool({ name: 'sync_memos', arguments: { action: 'sync' } }),
      ).rejects.toThrow();
      expect(control).toHaveBeenCalledTimes(3);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('mounts and removes the DSH MCP client as login state changes', async () => {
    const changes = new Set<() => void>();
    const runtime: any = { api: { state: undefined, changes } };
    const disposeFiber = vi.fn(async () => {});
    const ctx = {
      plugin: vi.fn((_plugin: unknown, _config: unknown) => ({ dispose: disposeFiber })),
    };
    const control = vi.fn(async () => ({ phase: 'ready' }));
    const dispose = installSyncMcp(ctx, { control }, runtime, async () => ({}) as any);
    try {
      expect(ctx.plugin).not.toHaveBeenCalled();
      runtime.api.state = { username: 'synthetic' };
      changes.forEach((callback) => callback());
      await vi.waitFor(() => expect(ctx.plugin).toHaveBeenCalledOnce());
      const config = ctx.plugin.mock.calls[0][1] as any;
      expect(config.serverName).toBe('dogo_memo');
      expect(config.transport).toBe('streamable-http');
      expect(config.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
      runtime.api.state = undefined;
      changes.forEach((callback) => callback());
      await vi.waitFor(() => expect(disposeFiber).toHaveBeenCalledOnce());
    } finally {
      await dispose();
    }
  });
});
