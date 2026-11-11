import { afterEach, expect, it, vi } from 'vitest';
import { registerMemoPicker } from '../memos/conversation.js';

function fixture() {
  const insertQuote = vi.fn(() => true);
  const notify = vi.fn();
  const input = { actions: { insertQuote }, notify };
  const binding = { ctx: {} };
  let current: typeof binding | undefined = binding;
  let contribution: any;
  const scope = {
    sessions: { binding: vi.fn(() => current) },
    conversation: { input: { for: vi.fn(() => input) } },
    get: () => ({ register: (value: any) => (contribution = value) }),
    effect: (effect: any) => effect(),
  };
  const ctx = { inject: (_deps: string[], apply: any) => apply(scope) };
  const control = vi.fn();
  registerMemoPicker(
    ctx,
    control,
    () => null,
    () => null,
  );
  return {
    contribution,
    control,
    insertQuote,
    notify,
    close: () => {
      current = undefined;
    },
  };
}

afterEach(() => vi.useRealTimers());

it('lists all local memo pages as selectable options', async () => {
  const f = fixture();
  f.control
    .mockResolvedValueOnce({
      items: [{ id: 'a', content: '第一条\n正文 A', updated_at: 10 }],
      next_cursor: 'a',
    })
    .mockResolvedValueOnce({
      items: [{ id: 'b', content: '第二条\n正文 B', updated_at: 20 }],
      next_cursor: null,
    });
  const options = await f.contribution.ui.options(
    { sessionId: 'session' },
    new AbortController().signal,
  );
  expect(f.contribution.label()).toBe('备忘录');
  expect(f.control).toHaveBeenNthCalledWith(1, 'list', {});
  expect(f.control).toHaveBeenNthCalledWith(2, 'list', { cursor: 'a' });
  expect(options.map((x: any) => x.id)).toEqual(['b', 'a']);
  expect(options[0]).toMatchObject({
    label: '第二条',
    detail: '正文 B',
  });
});

it('quotes the latest saved content after the command menu settles without submitting', async () => {
  vi.useFakeTimers();
  const f = fixture();
  f.control.mockResolvedValueOnce({ content: '标题\n最新正文', deleted_at: null });
  await f.contribution.ui.onSelect({ id: 'a' }, { sessionId: 'session' });
  expect(f.insertQuote).not.toHaveBeenCalled();
  vi.runAllTimers();
  expect(f.insertQuote).toHaveBeenCalledOnce();
  expect(f.insertQuote).toHaveBeenCalledWith('备忘录\n标题\n最新正文');
  expect(f.control).toHaveBeenCalledTimes(1);
  expect(f.control).toHaveBeenCalledWith('get', { id: 'a' });
});

it('does not insert into a closed session and surfaces a refused insertion', async () => {
  vi.useFakeTimers();
  const f = fixture();
  f.control.mockResolvedValueOnce({ content: '正文', deleted_at: null });
  await f.contribution.ui.onSelect({ id: 'a' }, { sessionId: 'session' });
  f.close();
  vi.runAllTimers();
  expect(f.insertQuote).not.toHaveBeenCalled();

  const next = fixture();
  next.insertQuote.mockReturnValue(false);
  next.control.mockResolvedValueOnce({ content: '正文', deleted_at: null });
  await next.contribution.ui.onSelect({ id: 'a' }, { sessionId: 'session' });
  vi.runAllTimers();
  expect(next.notify).toHaveBeenCalledWith('error', expect.stringContaining('不能加入引用'));
});

it('does not quote after the picker is dismissed or if the memo has been deleted', async () => {
  vi.useFakeTimers();
  const f = fixture();
  const controller = new AbortController();
  f.control.mockImplementationOnce(async () => {
    controller.abort();
    return { content: '正文', deleted_at: null };
  });
  await f.contribution.ui.onSelect(
    { id: 'a', signal: controller.signal },
    { sessionId: 'session' },
  );
  vi.runAllTimers();
  expect(f.insertQuote).not.toHaveBeenCalled();
  f.control.mockResolvedValueOnce({ content: '正文', deleted_at: 1 });
  await expect(f.contribution.ui.onSelect({ id: 'a' }, { sessionId: 'session' })).rejects.toThrow(
    '已删除',
  );
});

it('aborts loading and rejects non-advancing pagination', async () => {
  const f = fixture();
  const aborted = new AbortController();
  aborted.abort();
  await expect(
    f.contribution.ui.options({ sessionId: 'session' }, aborted.signal),
  ).rejects.toThrow();
  expect(f.control).not.toHaveBeenCalled();
  f.control.mockResolvedValue({ items: [], next_cursor: 'same' });
  await expect(
    f.contribution.ui.options({ sessionId: 'session' }, new AbortController().signal),
  ).rejects.toThrow('分页无效');
});
