import { z } from 'zod';
import { mutation, type Runtime } from '../shared/runtime.js';
import { LocalMemos } from './local-store.js';
import { MemoSync } from './sync.js';

/** The interface and AI tools use this same local-first service. */
export class MemoService {
  readonly local: LocalMemos;
  readonly sync: MemoSync;
  private deviceFlight?: Promise<any[]>;

  constructor(private readonly runtime: Runtime) {
    this.local = new LocalMemos(runtime.store);
    this.sync = new MemoSync(runtime, this.local);
  }

  private async selectOwner() {
    await this.local.activateOwner(this.sync.owner());
  }

  private async devices() {
    const owner = this.sync.owner() || (await this.local.currentOwner());
    if (owner === 'unowned') return [];
    const key = 'memo-devices-' + owner;
    const cached = await this.runtime.store.read<any[]>(key, []);
    const cachedWithUnknownStatus = () =>
      cached.map((device) => ({ ...device, online: undefined }));
    if (!this.sync.owner()) return cachedWithUnknownStatus();
    const refresh = () => {
      if (!this.deviceFlight)
        this.deviceFlight = (async () => {
          await this.sync.ensureReachableBeforeRefresh();
          const input = await this.runtime.control('devices');
          const devices = z
            .array(
              z.object({
                id: z.string(),
                name: z.string(),
                kind: z.string(),
                active: z.boolean(),
                online: z.boolean().optional(),
              }),
            )
            .parse(input);
          if (this.sync.owner() !== owner) throw Error('DogO 账户已变化。');
          await this.runtime.store.write(key, devices);
          return devices;
        })().finally(() => {
          this.deviceFlight = undefined;
        });
      return this.deviceFlight;
    };
    // Do not present cached online flags as current, but prefer a quick live
    // response so that a reachable device is not permanently shown offline.
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        refresh(),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(Error('设备状态刷新超时。')), 2000);
          timeout.unref?.();
        }),
      ]);
    } catch {
      return cachedWithUnknownStatus();
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  async submit(input: unknown) {
    const owner = this.sync.owner();
    await this.local.activateOwner(owner);
    const selected = owner || (await this.local.currentOwner());
    const op = mutation.parse(input);
    if (op.method !== 'create' && !op.id.startsWith('local-'))
      throw Error('请重新读取备忘录，使用返回的本机 ID 和版本进行修改。');
    const result = await this.local.submit(op, selected === 'unowned' ? null : selected);
    this.sync.kick();
    return result;
  }

  async control(method: string, payload: any = {}) {
    switch (method) {
      case 'status':
        await this.selectOwner();
        return {
          ...(await this.runtime.control('status')),
          memoIdentity: await this.local.currentOwner(),
          sync: this.sync.status(),
        };
      case 'login': {
        const value = await this.runtime.control('login', payload);
        await this.selectOwner();
        this.sync.kick();
        return value;
      }
      case 'logout': {
        const value = await this.runtime.control('logout', payload);
        this.sync.kick();
        return value;
      }
      case 'sync-status':
        return this.sync.status();
      case 'sync-now':
        this.sync.kick();
        return this.sync.status();
      case 'devices':
        return this.devices();
      case 'list':
        await this.selectOwner();
        return this.local.list(payload);
      case 'get': {
        await this.selectOwner();
        const id = z.string().min(1).max(128).parse(payload.id);
        if (id.startsWith('local-')) return this.local.get(id);
        const cached = await this.local.findCurrentRemote(id);
        if (cached) return cached;
        const owner = this.sync.owner();
        if (!owner) throw Error('这条旧线上记录尚未下载到本机，请连接后读取。');
        const remote = await this.runtime.control('get', { id });
        await this.local.ingest(owner, remote);
        return this.local.findRemote(owner, id);
      }
      case 'get-server':
        return this.runtime.control('get', payload);
      case 'submit':
        return this.submit(payload);
      case 'pending':
        return this.sync.owner() ? this.runtime.pending() : null;
      case 'retry': {
        const result: any = await this.runtime.control('retry');
        const owner = this.sync.owner();
        if (owner && result?.id) {
          await this.local.ingest(owner, result);
          this.sync.kick();
          return (await this.local.findRemote(owner, result.id)) || result;
        }
        this.sync.kick();
        return result;
      }
      case 'discard': {
        const value = await this.runtime.control('discard');
        this.sync.kick();
        return value;
      }
      default:
        return this.runtime.control(method, payload);
    }
  }
}
