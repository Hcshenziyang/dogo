import WebSocket from 'ws';
import { Api, accountKey } from '../shared/api.js';
import { Store } from '../shared/store.js';
import { NativeSessions } from './native.js';
import { Delivery } from './delivery.js';
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { proxyFor } from '../shared/proxy.js';

interface Config {
  enabled: boolean;
  cwd: string;
}
export class Consumer {
  config: Config = { enabled: false, cwd: homedir() };
  online = false;
  error = '';
  private socket?: WebSocket;
  private retry?: ReturnType<typeof setTimeout>;
  private rotation?: ReturnType<typeof setTimeout>;
  private attempt = 0;
  private generation = 0;
  private stopped = false;
  private serial = Promise.resolve();
  private active = 0;
  private delivery: Delivery;
  private wake = () => this.restart();
  constructor(
    private api: Api,
    private store: Store,
    private native: NativeSessions,
  ) {
    this.delivery = new Delivery(store, native);
  }
  async start() {
    this.config = await this.store.read('consumer', this.config);
    this.api.changes.add(this.wake);
    this.restart();
  }
  async configure(enabled: boolean, cwd: string) {
    cwd = cwd.trim();
    // Turning access off must remain possible after a directory is removed.
    if (enabled) {
      if (!cwd) throw Error('请先填写默认执行目录，再开启本机访问。');
      if (!isAbsolute(cwd)) throw Error('默认执行目录需要填写本机的绝对路径。');
      try {
        if (!(await stat(cwd)).isDirectory()) throw Error('not a directory');
        cwd = await realpath(cwd);
      } catch {
        throw Error('默认执行目录不存在或无法访问，请选择本机已有的文件夹。');
      }
    }
    const config = { enabled, cwd };
    await this.store.write('consumer', config);
    this.config = config;
    this.error = '';
    this.restart();
    return this.view();
  }
  view() {
    return { ...this.config, online: this.online, error: this.error };
  }
  private restart() {
    this.generation++;
    this.online = false;
    clearTimeout(this.retry);
    clearTimeout(this.rotation);
    this.socket?.close();
    if (!this.stopped && this.config.enabled && this.api.state) void this.connect(this.generation);
  }
  private async connect(generation: number) {
    try {
      if (!(await stat(this.config.cwd)).isDirectory()) throw Error('执行目录不可用。');
      const token = await this.api.token(),
        state = this.api.state!;
      const proxy = await proxyFor(state.server);
      if (generation !== this.generation) return;
      const ws = new WebSocket(state.server.replace(/^http/, 'ws') + '/api/device/connect', {
        headers: { Authorization: 'Bearer ' + token },
        ...(proxy ? { agent: new HttpsProxyAgent(proxy) } : {}),
        maxPayload: 2 * 1024 * 1024,
        handshakeTimeout: 10000,
      });
      this.socket = ws;
      const send = (value: unknown) => {
        if (ws.readyState === WebSocket.OPEN && generation === this.generation)
          ws.send(JSON.stringify(value));
      };
      let lastFrame = Date.now();
      const heartbeat = setInterval(() => {
        if (Date.now() - lastFrame > 50000) ws.terminate();
        else send({ type: 'ping' });
      }, 20000);
      ws.on('error', () => {
        this.error = '设备连接失败，正在重试。';
      });
      ws.on('close', (code) => {
        clearInterval(heartbeat);
        if (generation !== this.generation) return;
        this.online = false;
        clearTimeout(this.rotation);
        if (code === 4401 && this.api.state) {
          void this.api
            .refresh()
            .then(() => {
              if (generation === this.generation) this.restart();
            })
            .catch((e) => {
              this.error = (e as Error).message;
            });
        } else if (!this.stopped && this.api.state)
          this.retry = setTimeout(
            () => void this.connect(generation),
            Math.min(30000, 1000 * 2 ** Math.min(this.attempt++, 5)),
          );
      });
      ws.on('message', (raw) => {
        if (generation !== this.generation) return;
        lastFrame = Date.now();
        let m: any;
        try {
          m = JSON.parse(raw.toString());
        } catch {
          ws.close();
          return;
        }
        if (m.type === 'connected') {
          this.online = true;
          this.error = '';
          this.attempt = 0;
        }
        if (m.type === 'ping') send({ type: 'pong' });
        if (m.type === 'error') this.error = String(m.code ?? 'device_error');
        if (m.type === 'dispatch') {
          this.serial = this.serial.then(async () => {
            if (generation !== this.generation) return;
            try {
              const ack = await this.delivery.receive(
                m.dispatch,
                accountKey(state.server, state.username),
                state.tokens.device_id,
                this.config.cwd,
              );
              send(ack);
              this.error = '';
            } catch (e) {
              this.error = (e as Error).message;
            }
          });
        }
        if (m.type === 'remote.call') {
          if (this.active >= 8) {
            send({
              type: 'remote.result',
              id: m.id,
              ok: false,
              error: '设备请求过多，请稍后重试。',
            });
            return;
          }
          this.active++;
          void this.native
            .remote(m.call, this.config.cwd)
            .then((value) => {
              const response = { type: 'remote.result', id: m.id, ok: true, value };
              if (Buffer.byteLength(JSON.stringify(response)) > 2 * 1024 * 1024)
                throw Error('会话内容过大，请在执行设备上查看。');
              send(response);
            })
            .catch((e) =>
              send({ type: 'remote.result', id: m.id, ok: false, error: (e as Error).message }),
            )
            .finally(() => this.active--);
        }
      });
      // Replace the authenticated socket before its access token expires.
      this.rotation = setTimeout(
        async () => {
          try {
            await this.api.refresh();
            this.restart();
          } catch (e) {
            this.error = (e as Error).message;
          }
        },
        Math.max(1000, state.expiresAt - Date.now() - 20000),
      );
    } catch (e) {
      this.error = (e as Error).message;
      if (generation === this.generation && !this.stopped && this.api.state)
        this.retry = setTimeout(() => void this.connect(generation), 5000);
    }
  }
  stop() {
    this.stopped = true;
    this.api.changes.delete(this.wake);
    this.restart();
  }
}
