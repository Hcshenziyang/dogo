import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Api, serverURL } from '../shared/api.js';
import { Store } from '../shared/store.js';
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
    expect(fetcher).toHaveBeenCalledTimes(3); // login, reachability probe, refresh
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
    expect(fetcher).toHaveBeenCalledTimes(3); // login, reachability probe, refresh
    expect(api.state!.tokens).toEqual(tokens);
  });
  it('renames the existing device and stores the newly issued credentials', async () => {
    const { store, credentials } = await setup();
    const replacement = { ...tokens, access_token: 'new-access', refresh_token: 'n'.repeat(32) };
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(response(tokens))
      .mockResolvedValueOnce(response(replacement));
    const api = new Api(store, credentials, fetcher);
    await api.login('https://example.test', 'alice', 'password', '我的电脑');
    const changed = vi.fn();
    api.changes.add(changed);

    await api.renameDevice('书房电脑', 'password');

    expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({
      username: 'alice',
      password: 'password',
      device_id: 'device',
      device_name: '书房电脑',
      device_kind: 'desktop',
    });
    expect(api.state?.tokens).toEqual(replacement);
    const saved = await credentials.readRecord();
    expect(saved.payload.tokens).toEqual(replacement);
    expect(JSON.stringify(saved)).not.toContain('password');
    expect(changed).toHaveBeenCalledOnce();
  });
  it('keeps the existing login when password verification fails', async () => {
    const { store, credentials } = await setup();
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(response(tokens))
      .mockResolvedValueOnce(response({ error: { code: 'invalid_credentials' } }, 401));
    const api = new Api(store, credentials, fetcher);
    await api.login('https://example.test', 'alice', 'password', 'B');
    await expect(api.renameDevice('书房电脑', 'wrong')).rejects.toThrow('账户密码不正确');
    expect(api.state?.tokens).toEqual(tokens);
    expect((await credentials.readRecord()).payload.tokens).toEqual(tokens);
    expect(await api.token()).toBe(tokens.access_token);
  });
  it('waits for a refresh already in progress before renaming', async () => {
    const { store, credentials } = await setup();
    let release!: () => void, started!: () => void;
    const refreshing = new Promise<void>((resolve) => {
      started = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const renewed = { ...tokens, access_token: 'refreshed', refresh_token: 'f'.repeat(32) };
    const renamed = { ...tokens, access_token: 'renamed', refresh_token: 'n'.repeat(32) };
    const calls: string[] = [];
    const fetcher = vi.fn(async (url: string, options: any) => {
      calls.push(options.method + ' ' + url.split('/api')[1]);
      if (url.endsWith('/api/auth/refresh')) {
        started();
        await gate;
        return response(renewed);
      }
      if (url.endsWith('/api/auth/login') && calls.length > 1) return response(renamed);
      return response(tokens);
    });
    const api = new Api(store, credentials, fetcher as any);
    await api.login('https://example.test', 'alice', 'password', 'B');
    const refresh = api.refresh();
    await refreshing;
    const rename = api.renameDevice('书房电脑', 'password');
    expect(calls).toHaveLength(3);
    release();
    await Promise.all([refresh, rename]);
    expect(calls).toEqual([
      'POST /auth/login',
      'HEAD /auth/me',
      'POST /auth/refresh',
      'POST /auth/login',
    ]);
    expect(api.state?.tokens).toEqual(renamed);
  });
  it('waits for a rename before processing a stale 401 or issuing a token', async () => {
    const { store, credentials } = await setup();
    let releaseLogin!: () => void, loginStarted!: () => void, releaseRequest!: () => void;
    const loginGate = new Promise<void>((resolve) => {
      releaseLogin = resolve;
    });
    const pendingLogin = new Promise<void>((resolve) => {
      loginStarted = resolve;
    });
    const requestGate = new Promise<void>((resolve) => {
      releaseRequest = resolve;
    });
    const renamed = { ...tokens, access_token: 'renamed', refresh_token: 'n'.repeat(32) };
    let logins = 0;
    const fetcher = vi.fn(async (url: string) => {
      if (url.endsWith('/api/devices')) {
        await requestGate;
        return response({}, 401);
      }
      if (url.endsWith('/api/auth/login')) {
        if (++logins === 1) return response(tokens);
        loginStarted();
        await loginGate;
        return response(renamed);
      }
      throw Error('unexpected token refresh');
    });
    const api = new Api(store, credentials, fetcher as any);
    await api.login('https://example.test', 'alice', 'password', 'B');
    const stale = expect(api.request('/api/devices')).rejects.toThrow('登录状态已变化');
    const rename = api.renameDevice('书房电脑', 'password');
    await pendingLogin;
    const nextToken = api.token();
    releaseRequest();
    releaseLogin();
    await Promise.all([rename, stale]);
    expect(await nextToken).toBe('renamed');
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(api.state?.tokens).toEqual(renamed);
  });
  it('reports an uncertain outcome if the rename response is lost', async () => {
    const { store, credentials } = await setup();
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(response(tokens))
      .mockRejectedValueOnce(Error('network lost'));
    const api = new Api(store, credentials, fetcher);
    await api.login('https://example.test', 'alice', 'password', 'B');
    await expect(api.renameDevice('书房电脑', 'password')).rejects.toThrow('更新结果未确认');
    expect(api.state?.tokens).toEqual(tokens);
  });
  it('clears an ambiguous refresh result instead of replaying the old refresh token', async () => {
    const { store, credentials } = await setup();
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(response(tokens))
      .mockResolvedValueOnce(response({}, 401))
      .mockRejectedValueOnce(Error('network lost'));
    const api = new Api(store, credentials, fetcher);
    await api.login('https://example.test', 'alice', 'password', 'B');
    await expect(api.refresh()).rejects.toThrow('network lost');
    expect(api.state).toBeUndefined();
    expect(await credentials.readRecord()).toBeUndefined();
  });
  it('preserves the refresh credential when the server cannot be reached before refresh', async () => {
    const { store, credentials } = await setup();
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(response(tokens))
      .mockRejectedValueOnce(Error('offline'));
    const api = new Api(store, credentials, fetcher);
    await api.login('https://example.test', 'alice', 'password', 'B');
    await expect(api.refresh()).rejects.toThrow('登录状态已保留');
    expect(api.state?.username).toBe('alice');
    expect(await credentials.readRecord()).toBeDefined();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
