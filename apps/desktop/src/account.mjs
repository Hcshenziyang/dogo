import { pairingSchema, serviceOrigin } from '@dogo/contracts/pairing';

const operations = new Set(['status', 'login', 'recover', 'devices', 'device', 'revoke', 'password', 'logout', 'disable-legacy']);
const safe = value => Object.fromEntries(['initialized', 'registrationEnabled', 'authenticated', 'legacy', 'username', 'device', 'expiresAt', 'recoveryCode', 'signInRequired', 'devices', 'revoked', 'ok'].filter(k => value[k] !== undefined).map(k => [k, value[k]]));

/** Main-process only. Passwords are transient; session tokens never cross renderer IPC. */
export class DesktopAccount {
  constructor({ platform, installationId, read, save, clear, connect, disconnect, fetcher = fetch, readOrigin = () => '', saveOrigin = () => {} }) {
    Object.assign(this, { platform, installationId, read, save, clear, connect, disconnect, fetcher, readOrigin, saveOrigin });
  }
  async request(url, op, args, token) {
    const response = await this.fetcher(url + '/v3/auth/' + op, {
      method: args === undefined ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(30000),
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(args === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: args === undefined ? undefined : JSON.stringify(args),
    });
    if (!response.ok) throw Object.assign(new Error(({ 400: '账号输入格式不正确；新密码至少 15 个字符', 401: '账号、密码或恢复码无效，或登录已过期',
      403: '当前操作未获授权；不开放账号注册', 409: '账号状态已改变，请刷新后重试', 429: '账号操作过于频繁，请稍后重试' })[response.status] ?? `账号服务 HTTP ${response.status}`), { status: response.status });
    if (!response.body) throw new Error('账号响应为空');
    let text = '', bytes = 0; const decoder = new TextDecoder();
    for await (const chunk of response.body) { bytes += chunk.byteLength; if (bytes > 256 * 1024) throw new Error('账号响应过大'); text += decoder.decode(chunk, { stream: true }); }
    return JSON.parse(text + decoder.decode());
  }
  async execute(input) {
    if (this.busy) throw new Error('账号操作正在进行，请稍后');
    this.busy = true;
    try { return await this.perform(input); } finally { this.busy = false; }
  }
  async perform(input) {
    if (!input || typeof input !== 'object' || !operations.has(input.op) || JSON.stringify(input).length > 32768 ||
      Object.keys(input).some(k => !['op', 'url', 'args'].includes(k))) throw new Error('无效账号操作');
    const key = this.read(), args = input.args ?? {};
    if (input.op === 'status' && !input.url && !key && !this.readOrigin()) return { configured: false, authenticated: false, url: '', canSetup: false };
    const url = new URL(serviceOrigin.parse(input.url || key?.url || this.readOrigin())).origin;
    const credential = key && new URL(key.url).origin === url ? key : undefined;
    if (input.op === 'status') {
      const info = await this.request(url, 'status');
      let me = {};
      if (credential) try { me = await this.request(url, 'me', undefined, credential.token); } catch (error) { if (error.status !== 401) throw error; }
      return { ...safe(info), ...safe(me), url, configured: !!credential, canSetup: false };
    }
    if (input.op === 'login') {
      // An expired account session must not prevent password-based login. Only pairing migrates IDs.
      const result = await this.request(url, input.op, { ...args, platform: this.platform, installationId: this.installationId },
        credential?.version === 1 ? credential.token : undefined);
      const pair = pairingSchema.parse({ version: 2, url, device: result.device, platform: this.platform, token: result.token });
      // Persist the account session before retiring a legacy login token.
      await this.save(pair);
      await this.saveOrigin(url);
      let warning;
      if (credential?.version === 1) {
        try { await this.request(url, 'disable-legacy', {}, pair.token); }
        catch { warning = '账号已登录；旧设备授权清理未完成，可在设备管理中撤销旧授权'; }
      }
      try { const state = await this.connect(pair); if (state?.connected === false) warning = '登录已安全保存；中转尚未连通，请刷新连接'; } catch { warning = '登录已安全保存；本地任务结束后重启 DogO 恢复连接'; }
      return { ...safe(result), authenticated: true, initialized: true, configured: true, url, warning };
    }
    if (input.op === 'recover') {
      const result = await this.request(url, 'recover', args);
      if (credential) { await this.disconnect(); await this.clear(); }
      return safe(result);
    }
    if (!credential) throw new Error('请先登录此服务');
    if (input.op === 'logout') {
      await this.disconnect();
      let warning;
      try { if (credential.version === 2) await this.request(url, 'logout', {}, credential.token); }
      catch { warning = '本机已退出；服务端未确认失效。请从另一台已登录设备撤销此设备。'; }
      await this.clear(); return { ok: true, warning };
    }
    const result = await this.request(url, input.op, input.op === 'devices' ? undefined : args, credential.token);
    if (input.op === 'password' || (input.op === 'revoke' && args.id === credential.device)) {
      await this.disconnect(); await this.clear();
    }
    return safe(result);
  }
}
