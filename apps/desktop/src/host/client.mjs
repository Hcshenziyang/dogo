import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { DshBackend } from './dsh.mjs';
import { Capabilities } from '../native/capabilities.mjs';
import { NativeState } from '../native/state.mjs';
import { hostHandshake } from '@dogo/contracts/host';

const defaults = { endpoint: 'http://127.0.0.1:8000/v1', model: '', contextWindow: 32768, maxTokens: 4096, relayUrl: '' };
export function readSettings(directory) {
  const file = path.join(directory, 'desktop.sqlite');
  if (!existsSync(file)) return defaults;
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    if (!db.prepare("SELECT name FROM sqlite_master WHERE name='config'").get()) return defaults;
    const row = db.prepare('SELECT data FROM config WHERE id=1').get(); return row ? JSON.parse(row.data) : defaults;
  } finally { db.close(); }
}

/** Thin process supervisor and authenticated client. Business services live inside DSH. */
export class DesktopHost {
  constructor(directory, { nodeBinary = process.execPath, env = {}, onSnapshot = () => {}, onOffline = () => {} } = {}) {
    this.directory = directory; this.onSnapshot = onSnapshot; this.onOffline = onOffline;
    this.nativeState = new NativeState(directory);
    this.backend = new DshBackend(directory, () => {}, { nodeBinary, env, hostServices: true });
    const host = this;
    this.native = new Capabilities({ directory, store: this.nativeState, dsh: this.backend,
      get closing() { return host.closing; }, hub: { get projects() { return host.nativeState.value('projects', []); } }, changed() {} }, undefined, { ...Object.fromEntries(['HOME', 'USERPROFILE', 'PATH', 'TMPDIR', 'TEMP', 'SystemRoot', 'LANG', 'SSH_AUTH_SOCK', 'DOGO_MAC_HELPER'].filter(k => process.env[k]).map(k => [k, process.env[k]])), ...env });
  }
  async start() {
    await this.native.start();
    try {
      await this.backend.ensure(readSettings(this.directory));
      const handshake = hostHandshake.parse(await this.backend.request('/host/health'));
      if (handshake.pid !== this.backend.child.pid || handshake.generation !== this.backend.generation) throw new Error('DSH 插件启动身份不匹配');
      await this.call('heartbeat'); await this.poll();
      this.timer = setInterval(() => void this.poll().catch(() => this.onOffline()), 1000);
      this.timer.unref?.();
      this.backend.child.once('exit', () => { if (!this.closing) { clearInterval(this.timer); this.onOffline(); } });
    } catch (error) { await this.close(); throw error; }
  }
  async call(method, params) {
    const timeout = ['connectRelay', 'disconnectRelay', 'refreshRelay', 'memorySync', 'memoryAction', 'prepare', 'shutdown'].includes(method) ? 90000 : 15000;
    const response = await this.backend.request('/host/rpc', { method, params }, undefined, timeout); return response.result;
  }
  async poll() {
    if (this.polling || this.closing) return;
    this.polling = (async () => { await this.call('heartbeat'); const value = await this.call('snapshot'); this.onSnapshot(value); })();
    try { await this.polling; } finally { this.polling = undefined; }
  }
  async request(method, params) {
    if (method === 'shutdown') { await this.close(); return true; }
    if (method === 'openDsh') return this.backend.webUrl;
    if (method === 'capabilitiesConfigure') { const value = await this.native.configure(params); await this.call('heartbeat'); await this.poll(); return value; }
    if (method === 'prepare') {
      let codexCli;
      if (this.native.policy.codex) {
        codexCli = false;
        try { codexCli = (await this.native.run('codex', ['login', 'status'], { timeout: 5000, limit: 16000 })).code === 0; } catch {}
      }
      return this.call(method, { ...params, codexCli });
    }
    if (method === 'configure') throw new Error('请在 DSH 原生设置中管理模型；兼容配置仅用于首次导入');
    const result = await this.call(method, params);
    if (method === 'registerProject' || method === 'updateProject') {
      const snapshot = await this.call('snapshot');
      this.nativeState.setValue('projects', snapshot.hub.projects);
      for (const job of this.native.active.values()) if (job.projectId && !snapshot.hub.projects.some(p => p.id === job.projectId && p.published && p.executionAllowed)) job.controller.abort();
    }
    await this.poll(); return result;
  }
  async close() {
    if (this.closing) return this.closing;
    clearInterval(this.timer);
    this.closing = (async () => {
      await this.polling?.catch(() => {});
      try { if (this.backend.state === 'ready') await this.call('shutdown'); }
      finally { try { await this.native.close(); } finally { await this.backend.close(); } }
    })();
    return this.closing;
  }
}
