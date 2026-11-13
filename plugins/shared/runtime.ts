import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { Api, type Credentials } from './api.js';
import { Store } from './store.js';
import { registerControlRoute } from '../vendor/dsh-remote/control-route.js';
import { finishLegacyMemoCleanup } from '../devices/cleanup-files.js';

const name = z.string().min(1).max(128);
export interface ConsumerPort {
  view(): unknown;
  configure(enabled: boolean, cwd: string): Promise<unknown>;
}
export class Runtime {
  readonly api: Api;
  consumer?: ConsumerPort;
  memoCleanupPending = false;
  private loggingIn = false;
  constructor(
    readonly store: Store,
    credentials: Credentials,
  ) {
    this.api = new Api(store, credentials);
  }
  async control(method: string, payload: any = {}) {
    switch (method) {
      case 'status':
        return { ...this.api.view(), consumer: this.consumer?.view(), memoCleanupPending: this.memoCleanupPending };
      case 'finish-memo-cleanup':
        if (this.memoCleanupPending) {
          await finishLegacyMemoCleanup(this.store.directory);
          this.memoCleanupPending = false;
        }
        return { completed: true };
      case 'login': {
        const p = z
          .object({
            server: z.string(),
            username: z.string().min(1).max(100),
            password: z.string().min(1).max(256),
            name: z.string().min(1).max(100),
          })
          .parse(payload);
        if (this.loggingIn) throw Error('正在处理，请稍后再试。');
        this.loggingIn = true;
        try {
          return await this.api.login(p.server, p.username, p.password, p.name);
        } finally {
          this.loggingIn = false;
        }
      }
      case 'logout': {
        if (this.loggingIn) throw Error('请等待当前操作结束。');
        this.loggingIn = true;
        try {
          return await this.api.logout();
        } finally {
          this.loggingIn = false;
        }
      }
      case 'devices':
        return this.api.request('/api/devices');
      case 'revoke':
        return this.api.request(
          '/api/devices/' + encodeURIComponent(name.parse(payload.id)),
          'DELETE',
        );
      case 'configure': {
        const p = z.object({ enabled: z.boolean(), cwd: z.string() }).parse(payload);
        if (!this.consumer) throw Error('设备插件尚未就绪。');
        return this.consumer.configure(p.enabled, p.cwd);
      }
      case 'remote':
        return this.api.request(
          '/api/remote/call',
          'POST',
          z
            .object({
              device_id: name,
              method: z.enum([
                'list',
                'snapshot',
                'create',
                'prompt',
                'cancel',
                'workspaces',
                'models',
                'selectModel',
              ]),
              args: z.record(z.unknown()),
            })
            .strict()
            .parse(payload),
        );
      default:
        throw Error('不支持的 DogO 操作。');
    }
  }
}

// The device plugin owns one in-process auth/refresh instance.
const symbol = Symbol.for('dogo.runtime.v1');
interface Shared {
  runtime: Runtime;
  references: number;
  release: () => Promise<void>;
}
export async function acquire(
  ctx: any,
): Promise<{ runtime: Runtime; release: () => Promise<void> }> {
  const global = globalThis as any;
  if (!global[symbol])
    global[symbol] = (async () => {
      const store = new Store(join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'dogo'));
      const release = await store.lock();
      try {
        const runtime = new Runtime(store, ctx.credentials);
        await runtime.api.load();
        return { runtime, references: 0, release };
      } catch (e) {
        await release();
        throw e;
      }
    })().catch((e: unknown) => {
      delete global[symbol];
      throw e;
    });
  const shared: Shared = await global[symbol];
  shared.references++;
  return {
    runtime: shared.runtime,
    release: async () => {
      if (--shared.references === 0) {
        await shared.release();
        delete global[symbol];
      }
    },
  };
}
export function registerControl(
  ctx: any,
  route: string,
  runtime: { control(method: string, payload?: any): Promise<unknown> },
) {
  return registerControlRoute(
    route,
    ctx.connection,
    async (method: string, payload: unknown) => {
      try {
        return { ok: true, value: await runtime.control(method, payload) };
      } catch (e) {
        return {
          ok: false,
          error: { code: 'dogo/request-failed', message: (e as Error).message, details: {} },
        };
      }
    },
    ctx.webServer,
  );
}
