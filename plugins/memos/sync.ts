import { z } from 'zod';
import { accountKey } from '../shared/api.js';
import { proxyFetch } from '../shared/proxy.js';
import type { Runtime } from '../shared/runtime.js';
import { LocalMemos, operationMatchesRemote, remoteMemo, type Outbox } from './local-store.js';

const page = z.object({
  items: z.array(remoteMemo),
  next_cursor: z.string().nullable(),
});

/** Synchronization is best-effort; callers always read and write the local store first. */
export class MemoSync {
  private flight?: Promise<void>;
  private again = false;
  private stopped = true;
  private timer?: ReturnType<typeof setInterval>;
  private phase: 'local' | 'syncing' | 'ready' | 'offline' | 'needs-review' = 'local';
  private lastSuccess: number | null = null;
  private error = '';
  private readonly onIdentityChange = () => this.kick();

  constructor(
    private readonly runtime: Runtime,
    private readonly local: LocalMemos,
    private readonly probe: typeof proxyFetch = proxyFetch,
  ) {}

  owner() {
    const state = this.runtime.api.state;
    return state ? accountKey(state.server, state.username) : null;
  }

  status() {
    return { phase: this.phase, last_success: this.lastSuccess, error: this.error };
  }

  start() {
    this.stopped = false;
    this.runtime.api.changes.add(this.onIdentityChange);
    this.timer = setInterval(() => this.kick(), 15000);
    this.timer.unref?.();
    this.kick();
    return () => {
      this.stopped = true;
      if (this.timer) clearInterval(this.timer);
      this.runtime.api.changes.delete(this.onIdentityChange);
    };
  }

  kick() {
    if (this.stopped) return;
    if (this.flight) {
      this.again = true;
      return;
    }
    this.flight = this.run()
      .catch((error: unknown) => {
        const status = Number((error as { status?: number })?.status || 0);
        this.phase = !this.owner()
          ? 'local'
          : status >= 400 && status < 500 && status !== 408 && status !== 429
            ? 'needs-review'
            : 'offline';
        this.error = error instanceof Error ? error.message : '同步失败';
      })
      .finally(() => {
        this.flight = undefined;
        if (this.again && !this.stopped) {
          this.again = false;
          this.kick();
        }
      });
  }

  async wait() {
    await this.flight;
  }

  async ensureReachableBeforeRefresh() {
    const state = this.runtime.api.state;
    if (!state || state.expiresAt >= Date.now() + 30000) return;
    try {
      const result = await this.probe(state.server + '/api/auth/me', {
        method: 'HEAD',
        redirect: 'error',
        signal: AbortSignal.timeout(4000),
      });
      if (result.status >= 500) throw Error('服务器不可用');
    } catch {
      throw Error('暂时无法连接服务器，本机内容已保存，登录状态保留。');
    }
  }

  private checkOwner(owner: string) {
    if (this.stopped || this.owner() !== owner) throw Error('DogO 账户已变化，同步已暂停。');
  }

  private async run() {
    const owner = this.owner();
    if (!owner) {
      this.phase = 'local';
      this.error = '';
      return;
    }
    this.phase = 'syncing';
    this.error = '';
    await this.local.activateOwner(owner);
    await this.ensureReachableBeforeRefresh();
    const legacyPending = await this.runtime.pending();
    if (!legacyPending) {
      for (const memo of await this.local.snapshot(owner)) {
        if (!memo.outbox) continue;
        this.checkOwner(owner);
        await this.send(owner, memo.id, memo.outbox, true);
      }
    }

    let cursor = '';
    for (let n = 0; n < 10000; n++) {
      this.checkOwner(owner);
      const query = new URLSearchParams({ include_deleted: 'true', limit: '100', cursor });
      const response = page.parse(await this.runtime.api.request('/api/memos?' + query));
      this.checkOwner(owner);
      await this.local.ingestBatch(owner, response.items);
      if (!response.next_cursor) break;
      if (response.next_cursor <= cursor) throw Error('服务器分页游标无效，同步已暂停。');
      cursor = response.next_cursor;
      if (n === 9999) throw Error('服务器备忘录过多，本轮同步已暂停。');
    }

    if (legacyPending) {
      this.phase = 'needs-review';
      this.error = '旧版待确认写入需要先核对；本机备忘录仍可使用。';
      return;
    }
    for (const memo of await this.local.snapshot(owner)) {
      if (!memo.dirty || memo.conflict_of) continue;
      this.checkOwner(owner);
      const pending = await this.local.prepare(owner, memo.id);
      if (pending) await this.send(owner, memo.id, pending, false);
    }
    this.checkOwner(owner);
    this.phase = 'ready';
    this.lastSuccess = Date.now();
    this.error = '';
  }

  private async send(owner: string, id: string, pending: Outbox, retry: boolean) {
    const op = pending.operation;
    if (retry && op.method !== 'create') {
      const remote = remoteMemo.parse(
        await this.runtime.api.request('/api/memos/' + encodeURIComponent(op.id)),
      );
      this.checkOwner(owner);
      if (remote.id !== op.id) throw Error('服务器返回的备忘录标识不匹配。');
      if (remote.revision < op.data.revision) throw Error('服务器备忘录版本发生回退。');
      if (remote.revision > op.data.revision || remote.deleted_at !== null) {
        if (operationMatchesRemote(op, remote))
          await this.local.confirm(owner, id, pending.token, remote);
        else await this.local.conflict(owner, id, pending.token, remote);
        return;
      }
    }
    let response: unknown;
    if (op.method === 'create')
      response = await this.runtime.api.request('/api/memos', 'POST', op.data);
    else {
      const path = '/api/memos/' + encodeURIComponent(op.id);
      response = await this.runtime.api.request(
        path + (op.method === 'append' ? '/append' : ''),
        op.method === 'append' ? 'POST' : op.method === 'update' ? 'PUT' : 'DELETE',
        op.data,
      );
    }
    this.checkOwner(owner);
    const remote = remoteMemo.parse(response);
    if (op.method === 'create') {
      if (remote.request_id !== op.data.request_id) throw Error('服务器返回的创建标识不匹配。');
      if (remote.revision > 1 && !operationMatchesRemote(op, remote)) {
        await this.local.conflict(owner, id, pending.token, remote);
        return;
      }
    } else if (remote.id !== op.id || remote.revision !== op.data.revision + 1) {
      throw Error('服务器返回的备忘录版本不符合预期。');
    }
    await this.local.confirm(owner, id, pending.token, remote);
  }
}
