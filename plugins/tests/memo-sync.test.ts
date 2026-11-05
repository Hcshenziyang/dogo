import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Runtime } from '../shared/runtime.js';
import { Store } from '../shared/store.js';
import { LocalMemos } from '../memos/local-store.js';
import { MemoSync } from '../memos/sync.js';

const paths: string[] = [];
const stops: (() => void)[] = [];
afterEach(async () => {
  for (const stop of stops.splice(0)) stop();
  for (const path of paths.splice(0)) await rm(path, { recursive: true, force: true });
});

async function setup() {
  const path = await mkdtemp(join(tmpdir(), 'dogo-sync-'));
  paths.push(path);
  const store = new Store(path);
  const runtime = new Runtime(store, {
    readRecord: async () => undefined,
    modifyRecord: async () => undefined,
    deleteRecord: async () => undefined,
  });
  runtime.api.state = {
    server: 'https://example.test',
    username: 'alice',
    tokens: { access_token: 'access', refresh_token: 'refresh', device_id: 'A', expires_in: 900 },
    expiresAt: Date.now() + 900000,
  };
  const records = new Map<string, any>();
  let offline = false;
  let lostResponse = '';
  let remoteId = 0;
  let afterUpdate: (() => Promise<void>) | undefined;
  const calls: { method: string; path: string; data: any }[] = [];
  const request = vi
    .spyOn(runtime.api, 'request')
    .mockImplementation(async (url, method = 'GET', data) => {
      if (offline) throw Error('offline');
      calls.push({ method, path: url, data });
      const parsed = new URL(url, 'https://example.test');
      const id = parsed.pathname.split('/').at(-1)!;
      if (parsed.pathname === '/api/memos' && method === 'GET') {
        const cursor = parsed.searchParams.get('cursor') || '';
        return {
          items: [...records.values()]
            .filter((m) => m.id > cursor)
            .sort((a, b) => a.id.localeCompare(b.id)),
          next_cursor: null,
        };
      }
      if (parsed.pathname === '/api/memos' && method === 'POST') {
        const body = data as any;
        let memo = [...records.values()].find((m) => m.request_id === body.request_id);
        if (!memo) {
          const now = Date.now();
          memo = {
            id: 'remote-' + ++remoteId,
            request_id: body.request_id,
            content: body.content,
            project: body.project,
            category: body.category,
            tags: body.tags,
            active: body.active,
            revision: 1,
            created_at: now,
            updated_at: now,
            deleted_at: null,
            plan: body.plan || null,
            dispatch: body.dispatch
              ? { ...body.dispatch, id: 'dispatch-1', status: 'pending' }
              : null,
          };
          records.set(memo.id, memo);
        }
        if (lostResponse === 'create') {
          lostResponse = '';
          throw Error('response lost');
        }
        return structuredClone(memo);
      }
      const existing = records.get(id);
      if (!existing) throw Error('not found');
      if (method === 'GET') return structuredClone(existing);
      const body = data as any;
      if (existing.revision !== body.revision) throw Error('revision conflict');
      if (method === 'PUT') {
        Object.assign(existing, {
          content: body.content,
          project: body.project,
          category: body.category,
          tags: body.tags,
          active: body.active,
          ...('plan' in body ? { plan: body.plan } : {}),
          revision: existing.revision + 1,
          updated_at: Date.now(),
        });
      } else if (method === 'DELETE') {
        Object.assign(existing, {
          active: false,
          deleted_at: Date.now(),
          revision: existing.revision + 1,
        });
      } else throw Error('unsupported fixture request');
      if (afterUpdate && method === 'PUT') {
        const callback = afterUpdate;
        afterUpdate = undefined;
        await callback();
      }
      if (lostResponse === 'update') {
        lostResponse = '';
        throw Error('response lost');
      }
      return structuredClone(existing);
    });
  const local = new LocalMemos(store);
  const sync = new MemoSync(runtime, local);
  stops.push(sync.start());
  await sync.wait();
  return {
    local,
    sync,
    runtime,
    store,
    records,
    calls,
    request,
    offline: (value: boolean) => {
      offline = value;
    },
    lose: (value: string) => {
      lostResponse = value;
    },
    afterUpdate: (callback: () => Promise<void>) => {
      afterUpdate = callback;
    },
    cycle: async () => {
      sync.kick();
      await sync.wait();
    },
    remote: (id = 'remote-existing', content = '线上原文') => {
      const now = Date.now();
      records.set(id, {
        id,
        request_id: 'request-' + id,
        content,
        project: '',
        category: '',
        tags: [],
        active: true,
        revision: 1,
        created_at: now,
        updated_at: now,
        deleted_at: null,
        dispatch: null,
      });
    },
  };
}

describe('local-first memo synchronization', () => {
  it('downloads an existing online memo, edits it offline after restart, then syncs the same record', async () => {
    const f = await setup();
    f.remote();
    await f.cycle();
    const before = (await f.local.list()).items[0];
    expect(before.content).toBe('线上原文');
    expect(before.sync_status).toBe('synced');
    f.offline(true);
    const reopened = new LocalMemos(f.store);
    const edited = await reopened.submit({
      method: 'append',
      id: before.id,
      data: { revision: before.revision, content: '\n离线修改' },
    });
    await f.cycle();
    expect((await reopened.get(before.id)).content).toBe('线上原文\n离线修改');
    expect(edited.sync_status).toBe('pending');
    f.offline(false);
    await f.cycle();
    expect(f.records.get('remote-existing').content).toBe('线上原文\n离线修改');
    expect((await reopened.get(before.id)).sync_status).toBe('synced');
    expect((await reopened.list()).items).toHaveLength(1);
  });

  it('preserves both sides as a visible conflict copy when edits race', async () => {
    const f = await setup();
    f.remote();
    await f.cycle();
    const before = (await f.local.list()).items[0];
    await f.local.submit({
      method: 'append',
      id: before.id,
      data: { revision: before.revision, content: ' 本地' },
    });
    Object.assign(f.records.get('remote-existing'), { content: '另一台设备修改', revision: 2 });
    await f.cycle();
    const items = (await f.local.list()).items;
    expect(items.map((m) => m.content).sort()).toEqual(['另一台设备修改', '线上原文 本地'].sort());
    expect(items.find((m) => m.content.includes('本地'))?.sync_status).toBe('conflict');
    await f.cycle();
    expect(f.records.size).toBe(1);
    expect((await f.local.list()).items).toHaveLength(2);
  });

  it('recovers an acknowledged update whose response was lost without appending twice', async () => {
    const f = await setup();
    f.remote();
    await f.cycle();
    const before = (await f.local.list()).items[0];
    await f.local.submit({
      method: 'append',
      id: before.id,
      data: { revision: before.revision, content: ' 一次' },
    });
    f.lose('update');
    await f.cycle();
    expect((await f.local.get(before.id)).sync_status).toBe('pending');
    await f.cycle();
    expect(f.records.get('remote-existing').content).toBe('线上原文 一次');
    expect(f.records.get('remote-existing').revision).toBe(2);
    expect((await f.local.get(before.id)).sync_status).toBe('synced');
    expect((await f.local.list()).items).toHaveLength(1);
  });

  it('retries a lost create using the exact saved request and does not duplicate the remote memo', async () => {
    const f = await setup();
    const memo = await f.local.submit({
      method: 'create',
      data: {
        request_id: 'stable-id',
        content: '本机新建',
        project: '',
        category: '',
        tags: [],
        active: true,
      },
    });
    f.lose('create');
    await f.cycle();
    await f.local.submit({
      method: 'append',
      id: memo.id,
      data: { revision: memo.revision, content: ' 后续修改' },
    });
    await f.cycle();
    await f.cycle();
    expect(f.records.size).toBe(1);
    expect([...f.records.values()][0].content).toBe('本机新建 后续修改');
    expect((await f.local.list()).items).toHaveLength(1);
  });

  it('retains a newer local edit made while an earlier update is in flight', async () => {
    const f = await setup();
    f.remote();
    await f.cycle();
    const before = (await f.local.list()).items[0];
    const first = await f.local.submit({
      method: 'append',
      id: before.id,
      data: { revision: before.revision, content: ' 第一次' },
    });
    f.afterUpdate(async () => {
      await f.local.submit({
        method: 'append',
        id: first.id,
        data: { revision: first.revision, content: ' 第二次' },
      });
    });
    await f.cycle();
    expect((await f.local.get(first.id)).content).toBe('线上原文 第一次 第二次');
    expect((await f.local.get(first.id)).sync_status).toBe('pending');
    await f.cycle();
    expect(f.records.get('remote-existing').content).toBe('线上原文 第一次 第二次');
    expect((await f.local.get(first.id)).sync_status).toBe('synced');
  });

  it('queues an offline instruction, then adds a later plan without losing either operation', async () => {
    const f = await setup();
    f.offline(true);
    const initial = await f.local.submit({
      method: 'create',
      data: {
        request_id: 'offline-dispatch',
        content: '待处理',
        project: '',
        category: '',
        tags: [],
        active: true,
        dispatch: { instruction: '处理一次', target_device_id: 'A' },
      },
    });
    const plan = {
      instruction: '每天整理',
      target_device_id: 'A',
      mode: 'daily',
      enabled: true,
      timezone: 'Asia/Shanghai',
      run_at: null,
      time: '09:00',
      weekday: null,
      day: null,
    };
    await f.local.submit({
      method: 'update',
      id: initial.id,
      data: {
        content: initial.content,
        project: '',
        category: '',
        tags: [],
        active: true,
        revision: initial.revision,
        plan,
      },
    });
    f.offline(false);
    await f.cycle();
    await f.cycle();
    const remote = [...f.records.values()][0];
    expect(remote.dispatch.instruction).toBe('处理一次');
    expect(remote.plan).toMatchObject({ instruction: '每天整理', mode: 'daily' });
    expect((await f.local.get(initial.id)).sync_status).toBe('synced');
    expect(f.calls.filter((c) => c.method === 'POST')).toHaveLength(1);
  });

  it('does not refresh or discard credentials when an expired session cannot reach the server', async () => {
    const f = await setup();
    f.runtime.api.state!.expiresAt = 0;
    const disconnected = new MemoSync(f.runtime, f.local, async () => {
      throw Error('offline');
    });
    const stop = disconnected.start();
    stops.push(stop);
    await disconnected.wait();
    expect(disconnected.status().phase).toBe('offline');
    expect(f.runtime.api.state?.username).toBe('alice');
  });
});
