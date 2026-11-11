import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MemoService } from '../memos/service.js';
import { Runtime } from '../shared/runtime.js';
import { Store } from '../shared/store.js';

const base = process.env.DOGO_RUST_TEST_URL;
const invite = process.env.DOGO_RUST_TEST_INVITE;

async function until<T>(read: () => Promise<T | undefined>, timeout = 10000): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw Error('Timed out waiting for isolated Rust synchronization');
}

function credentials() {
  const records = new Map<string, { payload: unknown }>();
  return {
    readRecord: async (key: string) => records.get(key),
    modifyRecord: async (key: string, update: () => Promise<any>) => {
      records.set(key, await update());
    },
    deleteRecord: async (key: string) => {
      records.delete(key);
    },
  };
}

describe.skipIf(!base || !invite)('real Rust memo service', () => {
  it('syncs local notes across clients and preserves concurrent offline edits', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dogo-rust-live-'));
    const username = 'test-' + randomUUID();
    const password = 'synthetic-test-password';
    const registered = await fetch(base! + '/api/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password, invite_code: invite }),
    });
    expect(registered.status).toBe(201);
    const first = new MemoService(new Runtime(new Store(join(root, 'first')), credentials()));
    const second = new MemoService(new Runtime(new Store(join(root, 'second')), credentials()));
    let stopFirst = first.sync.start();
    const stopSecond = second.sync.start();
    try {
      const created = await first.submit({
        method: 'create',
        data: { request_id: randomUUID(), content: '本地创建' },
      });
      await first.control('login', { server: base, username, password, name: 'synthetic-first' });
      await until(async () => {
        const memo = await first.control('get', { id: created.id });
        return memo.sync_status === 'synced' ? memo : undefined;
      });
      await second.control('login', { server: base, username, password, name: 'synthetic-second' });
      const secondMemo = await until(async () => {
        const list = await second.control('list');
        return list.items.find((item: any) => item.content === '本地创建');
      });

      stopFirst();
      await first.sync.wait();
      const firstMemo = await first.control('get', { id: created.id });
      await first.submit({
        method: 'update',
        id: firstMemo.id,
        data: {
          content: '离线修改',
          project: firstMemo.project,
          category: firstMemo.category,
          tags: firstMemo.tags,
          active: firstMemo.active,
          revision: firstMemo.revision,
        },
      });
      await second.submit({
        method: 'update',
        id: secondMemo.id,
        data: {
          content: '另一设备修改',
          project: secondMemo.project,
          category: secondMemo.category,
          tags: secondMemo.tags,
          active: secondMemo.active,
          revision: secondMemo.revision,
        },
      });
      await until(async () => {
        const memo = await second.control('get', { id: secondMemo.id });
        return memo.sync_status === 'synced' && memo.content === '另一设备修改' ? memo : undefined;
      });
      stopFirst = first.sync.start();
      const conflict = await until(async () => {
        const list = await first.control('list');
        return list.items.find((item: any) => item.sync_status === 'conflict');
      });
      expect(conflict.content).toBe('离线修改');
      const firstList = await first.control('list');
      expect(firstList.items.some((item: any) => item.content === '另一设备修改')).toBe(true);
      expect(await first.control('sync-report')).toMatchObject({ conflict_count: 1 });
      const latest = await second.control('get', { id: secondMemo.id });
      await second.submit({ method: 'delete', id: latest.id, data: { revision: latest.revision } });
      await until(async () => {
        const memo = await second.control('get', { id: latest.id });
        return memo.deleted_at !== null && memo.sync_status === 'synced' ? memo : undefined;
      });
      first.sync.kick();
      const afterDelete = await until(async () => {
        const list = await first.control('list');
        return list.items.every((item: any) => item.content !== '另一设备修改') ? list : undefined;
      });
      expect(afterDelete.items.some((item: any) => item.content === '离线修改')).toBe(true);
    } finally {
      stopFirst();
      stopSecond();
      await Promise.all([first.sync.wait(), second.sync.wait()]);
      await rm(root, { recursive: true, force: true });
    }
  }, 30000);
});
