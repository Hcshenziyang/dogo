import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Api, serverURL } from '../shared/api.js';
import { Store } from '../shared/store.js';
import { Runtime } from '../shared/runtime.js';
const paths: string[] = [];
afterEach(async () => {
  for (const p of paths.splice(0)) await rm(p, { recursive: true, force: true });
});
async function setup() {
  const p = await mkdtemp(join(tmpdir(), 'dogo-api-'));
  paths.push(p);
  let record: any;
  const credentials = {
    readRecord: async () => record,
    modifyRecord: async (_key: string, fn: any) => {
      record = await fn();
    },
    deleteRecord: async () => {
      record = undefined;
    },
  };
  return { store: new Store(p), credentials };
}
const tokens = {
  access_token: 'a',
  refresh_token: 'r'.repeat(32),
  device_id: 'device',
  expires_in: 900,
};
const response = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
describe('authentication and mutation boundaries', () => {
  it('requires HTTPS except loopback and forbids credential-bearing URLs', () => {
    expect(serverURL('http://127.0.0.1:8080')).toBe('http://127.0.0.1:8080');
    for (const url of [
      'http://example.com',
      'https://u:p@example.com',
      'https://example.com/api',
      'https://example.com/?token=x',
    ])
      expect(() => serverURL(url)).toThrow();
  });
  it('coalesces token rotation and never sends credentials to a redirect target', async () => {
    const { store, credentials } = await setup();
    const fetcher = vi.fn(async (_url: any, options: any) => {
      expect(options.redirect).toBe('error');
      await new Promise((r) => setTimeout(r, 5));
      return response(tokens);
    });
    const api = new Api(store, credentials, fetcher as any);
    await api.login('https://example.test', 'alice', 'test-password', 'B');
    api.state!.expiresAt = 0;
    await Promise.all([api.token(), api.token(), api.token()]);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(api.view())).not.toContain('access_token');
  });
  it('does not rotate an existing login while another request refreshes credentials', async () => {
    const { store, credentials } = await setup();
    const fetcher = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 5));
      return response(tokens);
    });
    const api = new Api(store, credentials, fetcher as any);
    await api.login('https://example.test', 'alice', 'password', 'B');
    api.state!.expiresAt = 0;
    await Promise.all([api.token(), api.login('https://example.test', 'alice', 'password', 'B')]);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(api.state!.tokens).toEqual(tokens);
  });
  it('clears an ambiguous refresh result instead of replaying the old refresh token', async () => {
    const { store, credentials } = await setup();
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(response(tokens))
      .mockRejectedValueOnce(Error('network lost'));
    const api = new Api(store, credentials, fetcher);
    await api.login('https://example.test', 'alice', 'password', 'B');
    await expect(api.refresh()).rejects.toThrow('network lost');
    expect(api.state).toBeUndefined();
    expect(await credentials.readRecord()).toBeUndefined();
  });
  it('keeps the exact mutation after an unknown result and refuses automatic revision changes', async () => {
    const { store, credentials } = await setup();
    const runtime = new Runtime(store, credentials);
    runtime.api.state = {
      server: 'https://example.test',
      username: 'alice',
      tokens,
      expiresAt: Date.now() + 100000,
    };
    const execute = vi
      .spyOn(runtime, 'execute')
      .mockRejectedValueOnce(Error('timeout'))
      .mockResolvedValueOnce({ id: 'memo' });
    const op = { method: 'append', id: 'memo', data: { revision: 2, content: '35元' } };
    await expect(runtime.submit(op)).rejects.toThrow('timeout');
    expect(await runtime.pending()).toEqual(op);
    await expect(runtime.submit({ ...op, data: { revision: 3, content: '35元' } })).rejects.toThrow(
      '待确认',
    );
    await runtime.submit(undefined, true);
    expect(execute.mock.calls[1][0]).toEqual(op);
    expect(await runtime.pending()).toBeNull();
  });
});
