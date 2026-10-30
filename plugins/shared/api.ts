import { createHash, randomUUID } from 'node:crypto';
import { Store } from './store.js';
import { proxyFetch } from './proxy.js';

export interface Credentials {
  readRecord(key: string): Promise<{ payload: unknown } | undefined>;
  modifyRecord(key: string, update: () => Promise<unknown>): Promise<unknown>;
  deleteRecord(key: string): Promise<unknown>;
}
interface Tokens {
  access_token: string;
  refresh_token: string;
  device_id: string;
  expires_in: number;
}
export interface LoginState {
  server: string;
  username: string;
  tokens: Tokens;
  expiresAt: number;
}
export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 0,
  ) {
    super(message);
  }
}
export function serverURL(value: string): string {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/')
    throw Error('服务地址只填写协议、域名和端口。');
  if (
    url.protocol !== 'https:' &&
    !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
  )
    throw Error('远端服务必须使用 HTTPS；HTTP 仅限本机调试。');
  return url.origin;
}
export const accountKey = (server: string, username: string) =>
  createHash('sha256')
    .update(server + '\0' + username)
    .digest('hex');
const key = 'dogo/session';

export class Api {
  state?: LoginState;
  generation = 0;
  private refreshFlight?: Promise<void>;
  readonly changes = new Set<() => void>();
  constructor(
    readonly store: Store,
    private credentials: Credentials,
    private fetcher: typeof fetch = proxyFetch as typeof fetch,
  ) {}
  async load() {
    const saved = await this.credentials.readRecord(key);
    this.state = saved?.payload as LoginState | undefined;
  }
  private changed() {
    this.generation++;
    for (const cb of this.changes) cb();
  }
  view() {
    return this.state
      ? {
          loggedIn: true,
          server: this.state.server,
          username: this.state.username,
          deviceId: this.state.tokens.device_id,
        }
      : { loggedIn: false };
  }
  async login(server: string, username: string, password: string, name: string) {
    await this.refreshFlight?.catch(() => {});
    server = serverURL(server);
    username = username.trim();
    if (this.state && (this.state.server !== server || this.state.username !== username))
      throw Error('切换服务器或账户前请先退出当前账户。');
    // Reopening the login panel must not rotate credentials behind an active refresh.
    if (this.state) return this.view();
    const identities = await this.store.read<Record<string, string>>('identities', {});
    const identity = accountKey(server, username);
    identities[identity] ??= randomUUID();
    await this.store.write('identities', identities);
    const epoch = this.generation;
    const tokens = await this.raw<Tokens>(server, '/api/auth/login', 'POST', {
      username,
      password,
      device_id: identities[identity],
      device_name: name,
      device_kind: 'desktop',
    });
    if (epoch !== this.generation) throw Error('登录状态已变化，请重试。');
    await this.save({ server, username, tokens, expiresAt: Date.now() + tokens.expires_in * 1000 });
    this.changed();
    return this.view();
  }
  private async save(state: LoginState) {
    await this.credentials.modifyRecord(key, async () => ({ kind: 'grant', payload: state }));
    this.state = state;
  }
  async logout() {
    const state = this.state;
    if (state) await this.request('/api/auth/logout', 'POST');
    await this.credentials.deleteRecord(key);
    this.state = undefined;
    this.changed();
  }
  async token(): Promise<string> {
    if (!this.state) throw new ApiError('login_required', '请先登录 DogO。', 401);
    if (this.state.expiresAt < Date.now() + 30000) await this.refresh();
    return this.state!.tokens.access_token;
  }
  async refresh() {
    if (this.refreshFlight) return this.refreshFlight;
    const state = this.state,
      epoch = this.generation;
    if (!state) throw new ApiError('login_required', '请先登录 DogO。', 401);
    this.refreshFlight = (async () => {
      try {
        const tokens = await this.raw<Tokens>(state.server, '/api/auth/refresh', 'POST', {
          refresh_token: state.tokens.refresh_token,
        });
        if (epoch !== this.generation) throw Error('登录状态已变化。');
        await this.save({ ...state, tokens, expiresAt: Date.now() + tokens.expires_in * 1000 });
      } catch (e) {
        // A rotated refresh result may be lost. Do not retry the old refresh token.
        if (epoch === this.generation) {
          await this.credentials.deleteRecord(key);
          this.state = undefined;
          this.changed();
        }
        throw e;
      }
    })().finally(() => {
      this.refreshFlight = undefined;
    });
    return this.refreshFlight;
  }
  async request<T = any>(path: string, method = 'GET', body?: unknown): Promise<T> {
    const token = await this.token(),
      state = this.state!,
      epoch = this.generation;
    try {
      return await this.raw<T>(state.server, path, method, body, token);
    } catch (e) {
      if (!(e instanceof ApiError) || e.status !== 401 || epoch !== this.generation) throw e;
      if (this.state?.tokens.access_token === token) await this.refresh();
      if (epoch !== this.generation) throw Error('登录状态已变化。');
      return this.raw<T>(state.server, path, method, body, await this.token());
    }
  }
  private async raw<T>(
    server: string,
    path: string,
    method: string,
    body?: unknown,
    token?: string,
  ): Promise<T> {
    const response = await this.fetcher(server + path, {
      method,
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data = (await response.json()) as any;
    if (!response.ok)
      throw new ApiError(
        data.error?.code ?? 'request_failed',
        data.error?.message ?? `请求失败 (${response.status})`,
        response.status,
      );
    return data as T;
  }
}
