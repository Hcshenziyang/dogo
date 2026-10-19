import type { AccountInput } from './account-types.ts';
import type { HubTransport } from './client.ts';

type Storage = { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void };
/** Same-origin web client: only the browser owns the HttpOnly session cookie. */
export class BrowserHub implements HubTransport {
  private origin: string;
  private storage: Storage;
  private fetcher: typeof fetch;
  private csrf = '';
  constructor(origin: string, storage: Storage, fetcher: typeof fetch = (input, options) => globalThis.fetch(input, options)) {
    this.origin = new URL(origin).origin; this.storage = storage; this.fetcher = fetcher;
  }
  private async request(path: string, body?: unknown, anonymous = false): Promise<any> {
    if (body !== undefined && !anonymous && !this.csrf) this.csrf = (await this.request('/v3/auth/me')).csrf;
    const response = await this.fetcher(this.origin + path, { method: body === undefined ? 'GET' : 'POST',
      credentials: 'same-origin', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(30000),
      headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(!anonymous && this.csrf ? { 'X-DogO-CSRF': this.csrf } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body) });
    if (response.status === 401) { this.csrf = ''; this.storage.removeItem('dogo.web.identity'); }
    if (!response.ok) throw Object.assign(new Error(response.status === 401 ? '请重新登录，或检查账号、密码与恢复码' : response.status === 429 ? '尝试过于频繁，请稍后再试' : `服务 HTTP ${response.status}，请检查输入和设备权限`), { status: response.status });
    return response.json();
  }
  account = async (input: AccountInput): Promise<any> => {
    if (input.url && new URL(input.url).origin !== this.origin) throw new Error('网页只连接当前网站，不会把登录信息发往其他地址');
    if (!['status', 'login', 'recover', 'devices', 'device', 'revoke', 'password', 'logout', 'disable-legacy'].includes(input.op)) throw new Error('请在已配对的电脑初始化个人账号');
    if (input.op === 'status') {
      const initialized = await this.request('/v3/auth/status');
      let me: any = {};
      try { me = await this.request('/v3/auth/me'); this.csrf = me.csrf; this.storage.setItem('dogo.web.identity', JSON.stringify({ device: me.device })); }
      catch (e) { if ((e as { status: number }).status !== 401) throw e; }
      return { ...initialized, ...me, url: this.origin, canSetup: false, configured: !!me.authenticated };
    }
    if (input.op === 'login') {
      let installationId = this.storage.getItem('dogo.web.installation');
      if (!installationId) { installationId = crypto.randomUUID(); this.storage.setItem('dogo.web.installation', installationId); }
      const value = await this.request('/v3/auth/login', { ...input.args, platform: 'web', installationId }, true);
      this.csrf = value.csrf; this.storage.setItem('dogo.web.identity', JSON.stringify({ device: value.device }));
      return { ...value, authenticated: true };
    }
    if (input.op === 'logout') {
      // Cookie invalidation must be confirmed: unlike native clients, JS cannot erase an HttpOnly cookie.
      await this.request('/v3/auth/logout', {}); this.csrf = ''; this.storage.removeItem('dogo.web.identity'); return { ok: true };
    }
    const value = await this.request('/v3/auth/' + input.op, input.op === 'devices' ? undefined : input.args ?? {}, input.op === 'recover');
    if (['password', 'recover'].includes(input.op) || (input.op === 'revoke' && input.args?.id === JSON.parse(this.storage.getItem('dogo.web.identity') || '{}').device)) {
      this.csrf = ''; this.storage.removeItem('dogo.web.identity');
    }
    return value;
  };
  async status() {
    try {
      const me = await this.request('/v3/auth/me'); this.csrf = me.csrf;
      this.storage.setItem('dogo.web.identity', JSON.stringify({ device: me.device }));
      return { configured: true, url: this.origin, device: me.device };
    } catch (error) {
      const old = JSON.parse(this.storage.getItem('dogo.web.identity') || '{}');
      if ((error as { status?: number }).status === 401 || !old.device) return { configured: false, url: this.origin, device: '' };
      if ((error as { status?: number }).status) throw error;
      return { configured: true, url: this.origin, device: old.device }; // Offline, cached data only; delivery still requires a valid session.
    }
  }
  async hub(input: { origin: string; op: string; args: Record<string, unknown> }) {
    if (input.origin !== this.origin) throw new Error('不能跨站传送任务');
    return this.request('/v2/hub', { op: input.op, args: input.args });
  }
  memory = async (input: { op: string; args?: Record<string, unknown> }): Promise<any> => {
    const call = (op: string, args: unknown = {}) => this.request('/v2/memory', { op, args });
    const a = input.args ?? {};
    if (input.op === 'status') return { enabled: true, remote: true, files: (await call('list')).files.map((f: any) => f.path) };
    if (input.op === 'sync') return { synced: true }; // Web reads the server directly; it is not a filesystem synchronizer.
    if (input.op === 'read') { const { file } = await call('read', a); return { content: file?.content ?? null, version: file?.version ?? 0 }; }
    if (input.op === 'write') {
      const result = await call('write', { path: a.path, content: a.content, baseVersion: a.version ?? 0 });
      if (result.conflict) throw new Error('记忆已变化，编辑已保存在冲突记录，请合并后重试'); return result;
    }
    if (input.op === 'rename') return call('rename', { path: a.path, target: a.target, baseVersion: a.version ?? 0 });
    if (input.op === 'export') {
      const files: Record<string, string> = {};
      for (const f of (await call('list')).files) { const { file } = await call('read', { path: f.path }); if (file?.content != null) files[f.path] = file.content; }
      return { format: 'dogo-personal-memory-v1', exportedAt: new Date().toISOString(), files };
    }
    return call(input.op, a);
  };
  watch(changed: () => void) {
    const stream = new EventSource(this.origin + '/v1/events/stream');
    stream.addEventListener('change', changed); return () => stream.close();
  }
}
