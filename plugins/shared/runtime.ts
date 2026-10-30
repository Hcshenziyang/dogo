import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { Api, accountKey, type Credentials } from './api.js';
import { Store } from './store.js';
import { registerControlRoute } from '../vendor/dsh-remote/control-route.js';

const name = z.string().min(1).max(128);
const memoFields = {
  content: z.string().max(256000),
  project: z.string().max(100).default(''),
  category: z.string().max(100).default(''),
  tags: z.array(z.string().min(1).max(100)).max(30).default([]),
  active: z.boolean().default(true),
};
export const mutation = z.discriminatedUnion('method', [
  z
    .object({
      method: z.literal('create'),
      data: z
        .object({
          ...memoFields,
          request_id: name,
          dispatch: z
            .object({ instruction: z.string().min(1).max(32000), target_device_id: name })
            .optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      method: z.literal('update'),
      id: name,
      data: z
        .object({
          content: memoFields.content,
          project: z.string().max(100),
          category: z.string().max(100),
          tags: z.array(z.string().min(1).max(100)).max(30),
          active: z.boolean(),
          revision: z.number().int().positive(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      method: z.literal('append'),
      id: name,
      data: z
        .object({ revision: z.number().int().positive(), content: z.string().max(256000) })
        .strict(),
    })
    .strict(),
  z
    .object({
      method: z.literal('delete'),
      id: name,
      data: z.object({ revision: z.number().int().positive() }).strict(),
    })
    .strict(),
]);
type Mutation = z.infer<typeof mutation>;
export interface ConsumerPort {
  view(): unknown;
  configure(enabled: boolean, cwd: string): Promise<unknown>;
}
export class Runtime {
  readonly api: Api;
  consumer?: ConsumerPort;
  private saving = false;
  private loggingIn = false;
  constructor(
    readonly store: Store,
    credentials: Credentials,
  ) {
    this.api = new Api(store, credentials);
  }
  identity() {
    if (!this.api.state) throw Error('请先登录 DogO。');
    return accountKey(this.api.state.server, this.api.state.username);
  }
  async pending() {
    return this.store.read<Mutation | null>('pending-' + this.identity(), null);
  }
  async submit(input: unknown, retry = false) {
    if (this.saving) throw Error('上一项写入仍在处理中。');
    this.saving = true;
    try {
      const identity = this.identity();
      const pending = await this.pending();
      if (pending && !retry) throw Error('存在待确认写入，请先重试或核对后放弃该记录。');
      const op = mutation.parse(retry ? pending : input);
      if (!retry) await this.store.write('pending-' + identity, op);
      const value = await this.execute(op);
      await this.store.write('pending-' + identity, null);
      return value;
    } finally {
      this.saving = false;
    }
  }
  async execute(op: Mutation) {
    if (op.method === 'create') return this.api.request('/api/memos', 'POST', op.data);
    const path = '/api/memos/' + encodeURIComponent(op.id);
    return this.api.request(
      path + (op.method === 'append' ? '/append' : ''),
      op.method === 'append' ? 'POST' : op.method === 'update' ? 'PUT' : 'DELETE',
      op.data,
    );
  }
  async control(method: string, payload: any = {}) {
    switch (method) {
      case 'status':
        return { ...this.api.view(), consumer: this.consumer?.view() };
      case 'login': {
        const p = z
          .object({
            server: z.string(),
            username: z.string().min(1).max(100),
            password: z.string().min(1).max(256),
            name: z.string().min(1).max(100),
          })
          .parse(payload);
        if (this.loggingIn || this.saving) throw Error('正在处理，请稍后再试。');
        this.loggingIn = true;
        try {
          return await this.api.login(p.server, p.username, p.password, p.name);
        } finally {
          this.loggingIn = false;
        }
      }
      case 'logout': {
        if (this.saving || this.loggingIn) throw Error('请等待当前操作结束。');
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
      case 'list': {
        const p = z
          .object({ project: z.string().optional(), cursor: z.string().optional() })
          .parse(payload);
        const query = new URLSearchParams({
          limit: '100',
          ...(p.project ? { project: p.project } : {}),
          ...(p.cursor ? { cursor: p.cursor } : {}),
        });
        return this.api.request('/api/memos?' + query);
      }
      case 'get':
        return this.api.request('/api/memos/' + encodeURIComponent(name.parse(payload.id)));
      case 'submit':
        return this.submit(payload);
      case 'pending':
        return this.pending();
      case 'retry':
        return this.submit(undefined, true);
      case 'discard':
        if (this.saving) throw Error('写入仍在处理中。');
        return this.store.write('pending-' + this.identity(), null);
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

// Both independently bundled plugins share one in-process auth/refresh owner.
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
export function registerControl(ctx: any, route: string, runtime: Runtime) {
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
