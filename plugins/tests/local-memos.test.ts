import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalMemos } from '../memos/local-store.js';
import { Store } from '../shared/store.js';

const paths: string[] = [];
afterEach(async () => {
  for (const path of paths.splice(0)) await rm(path, { force: true, recursive: true });
});
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'dogo-local-memos-'));
  paths.push(dir);
  const store = new Store(dir);
  return { dir, store, memos: new LocalMemos(store) };
}
const create = (request_id: string, content: string, project = '') => ({
  method: 'create',
  data: { request_id, content, project, category: '', tags: ['记录'], active: true },
});

describe('local memo persistence', () => {
  it('creates, reads, edits, appends and deletes without a login, retaining state on restart', async () => {
    const { store, memos } = await setup();
    const created = await memos.submit(create('create-1', '本地第一条', '生活'));
    expect(created.id).toMatch(/^local-/);
    expect(created.revision).toBe(1);
    const reopened = new LocalMemos(store);
    expect((await reopened.list({ project: '生活' })).items).toEqual([created]);
    expect(await reopened.get(created.id)).toEqual(created);
    const changed = await reopened.submit({
      method: 'update',
      id: created.id,
      data: {
        content: '本地修改',
        project: '生活',
        category: '',
        tags: ['更新'],
        active: true,
        revision: 1,
      },
    });
    expect(changed.revision).toBe(2);
    const appended = await reopened.submit({
      method: 'append',
      id: created.id,
      data: { content: '\nAI 追加', revision: 2 },
    });
    expect(appended.content).toBe('本地修改\nAI 追加');
    expect(appended.revision).toBe(3);
    await reopened.submit({ method: 'delete', id: created.id, data: { revision: 3 } });
    expect((await new LocalMemos(store).list()).items).toEqual([]);
    expect((await reopened.get(created.id)).deleted_at).not.toBeNull();
  });

  it('deduplicates creation and rejects concurrent updates using the same revision', async () => {
    const { memos, store } = await setup();
    const input = create('stable-request', '原始内容');
    const [first, retry] = await Promise.all([memos.submit(input), memos.submit(input)]);
    expect(first.id).toBe(retry.id);
    await expect(memos.submit(create('stable-request', '不同内容'))).rejects.toThrow('不同内容');
    const append = (content: string) => ({
      method: 'append',
      id: first.id,
      data: { revision: 1, content },
    });
    const secondOwner = new LocalMemos(store);
    const results = await Promise.allSettled([
      memos.submit(append('A')),
      secondOwner.submit(append('B')),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect((await memos.get(first.id)).content).toMatch(/^原始内容[AB]$/);
  });

  it('keeps locally cached accounts separate and retains access after logout', async () => {
    const { memos } = await setup();
    const unowned = await memos.submit(create('unowned', '尚未登录时记录'));
    await memos.activateOwner('account-a');
    expect((await memos.get(unowned.id)).content).toBe('尚未登录时记录');
    await memos.submit(create('a', '账户 A 记录'));
    await memos.activateOwner('account-b');
    expect((await memos.list()).items).toEqual([]);
    await memos.submit(create('b', '账户 B 记录'));
    await expect(
      memos.submit(create('wrong-account', '不能写到错误账户'), 'account-a'),
    ).rejects.toThrow('账户已变化');
    await memos.activateOwner('account-a');
    expect((await memos.list()).items.map((m) => m.content).sort()).toEqual(
      ['尚未登录时记录', '账户 A 记录'].sort(),
    );
  });

  it('keeps an explicitly requested instruction locally until it can be synchronized', async () => {
    const { memos } = await setup();
    const input = create('not-remote', '不应丢失指令');
    const saved = await memos.submit({
      ...input,
      data: { ...input.data, dispatch: { instruction: '处理', target_device_id: 'computer' } },
    });
    expect(saved.dispatch).toMatchObject({ instruction: '处理', local_pending: true });
    expect(saved.sync_status).toBe('local');
  });

  it('does not overwrite invalid local data or discard a valid previous write after failure', async () => {
    const { dir, store, memos } = await setup();
    const original = await memos.submit(create('one', '保留内容'));
    const write = vi.spyOn(store, 'write').mockRejectedValueOnce(Error('disk full'));
    await expect(memos.submit(create('two', '写入失败'))).rejects.toThrow('disk full');
    expect((await memos.list()).items).toEqual([original]);
    write.mockRestore();
    const path = join(dir, 'local-memos-v1.json');
    await writeFile(path, '{"version":1,"items":"invalid"}');
    const before = await readFile(path, 'utf8');
    await expect(memos.submit(create('three', '不要覆盖'))).rejects.toThrow('本机备忘录数据无效');
    expect(await readFile(path, 'utf8')).toBe(before);
  });
});
