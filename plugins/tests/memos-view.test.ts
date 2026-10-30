import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemosView } from '../memos/view.js';
import { createUI } from '../shared/ui.js';
import { draftKey } from '../shared/presentation.js';

// Deterministic hook/element harness. These are component-state tests, not browser layout tests.
function fixture() {
  const state: any[] = [],
    effects: any[] = [],
    jobs: Promise<any>[] = [];
  let cursor = 0,
    changed = true,
    tree: any;
  const h = (type: any, props: any, ...children: any[]): any => {
    const values = children.flat(Infinity).filter((v) => v !== false && v != null);
    if (typeof type === 'function')
      return type({ ...props, children: values.length ? values : undefined });
    return { type, props: props || {}, children: values };
  };
  const React = {
    createElement: h,
    Fragment: 'fragment',
    useState(initial: any) {
      const index = cursor++;
      if (!(index in state)) state[index] = typeof initial === 'function' ? initial() : initial;
      return [
        state[index],
        (value: any) => {
          state[index] = typeof value === 'function' ? value(state[index]) : value;
          changed = true;
        },
      ];
    },
    useRef(value: any) {
      const index = cursor++;
      return (state[index] ||= { current: value });
    },
    useEffect(fn: any, deps?: any[]) {
      const index = cursor++,
        previous = state[index];
      if (!previous || !deps || deps.some((value, i) => value !== previous.deps?.[i])) {
        effects.push(() => {
          previous?.cleanup?.();
          state[index] = { deps, cleanup: fn() };
        });
      }
    },
  };
  let records = [
    {
      id: 'a',
      content: '第一条\n正文',
      project: '工作',
      category: '原分类',
      tags: [],
      active: true,
      revision: 4,
      updated_at: 30,
    },
    {
      id: 'b',
      content: '第二条',
      project: '生活',
      category: '',
      tags: ['目标标签'],
      active: true,
      revision: 3,
      updated_at: 20,
    },
    {
      id: 'c',
      content: '最后一页',
      project: '工作',
      category: '',
      tags: [],
      active: true,
      revision: 2,
      updated_at: 10,
    },
  ];
  let pending: any = null,
    fail = false;
  const control = vi.fn(async (method: string, data: any = {}) => {
    if (method === 'pending') return pending;
    if (method === 'get') return structuredClone(records.find((m) => m.id === data.id));
    if (method === 'list') {
      const list = records.filter((m) => !data.project || m.project === data.project);
      return {
        items: structuredClone(list.slice(data.cursor ? 2 : 0, data.cursor ? 99 : 2)),
        next_cursor: !data.cursor && list.length > 2 ? 'more' : '',
      };
    }
    if (method === 'submit') {
      if (fail) {
        pending = structuredClone(data);
        throw Error('unknown write');
      }
      if (data.method === 'delete') {
        records = records.filter((m) => m.id !== data.id);
        return;
      }
      const result = { ...data.data, id: data.id || 'created', revision: 5, updated_at: 40 };
      records = [result, ...records.filter((m) => m.id !== result.id)];
      return result;
    }
    if (method === 'retry') {
      throw Error('still uncertain');
    }
  });
  const props: any = {
    control,
    status: { server: 'https://fixture.test', username: 'test' },
    devices: [{ id: 'device', name: '测试电脑', kind: 'desktop', active: true }],
    busy: false,
    setError: vi.fn(),
    notify: vi.fn(),
    confirmAction: vi.fn(),
    openSettings: vi.fn(),
  };
  props.run = (fn: any) => {
    if (props.busy) return;
    props.busy = true;
    const job = Promise.resolve()
      .then(fn)
      .catch(() => {})
      .finally(() => {
        props.busy = false;
        changed = true;
      });
    jobs.push(job);
    return job;
  };
  const Component = createMemosView(React, createUI(React));
  const flush = async () => {
    for (let n = 0; n < 30 && (changed || jobs.length); n++) {
      if (changed) {
        changed = false;
        cursor = 0;
        tree = Component(props);
        while (effects.length) effects.shift()();
      }
      if (jobs.length) await Promise.all(jobs.splice(0));
    }
  };
  const all = (predicate: any, node = tree): any[] =>
    typeof node === 'object' && node
      ? [
          ...(predicate(node) ? [node] : []),
          ...node.children.flatMap((child: any) => all(predicate, child)),
        ]
      : [];
  const text = (node: any): string =>
    typeof node === 'string' ? node : node?.children?.map(text).join('') || '';
  const named = (name: string) =>
    all((n: any) => n.props['aria-label'] === name || (n.type === 'button' && text(n) === name))[0];
  return {
    flush,
    all,
    named,
    text,
    control,
    props,
    setFailure: () => {
      fail = true;
    },
    pending: () => pending,
    tiles: () => all((n: any) => n.props.className === 'dg-memo-tile'),
    click: async (name: string) => {
      named(name).props.onClick();
      await flush();
    },
    edit: async (name: string, value: string) => {
      named(name).props.onChange({ target: { value } });
      await flush();
    },
  };
}
beforeEach(() => {
  const memory = new Map();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => memory.get(key) || null,
    setItem: (key: string, value: string) => memory.set(key, value),
    removeItem: (key: string) => memory.delete(key),
  });
  vi.stubGlobal('window', { addEventListener() {}, removeEventListener() {} });
  vi.stubGlobal('document', { activeElement: null });
  vi.stubGlobal('requestAnimationFrame', (fn: any) => fn());
});
afterEach(() => vi.unstubAllGlobals());

describe('formal memo grid flows', () => {
  it('renders a full grid without pin controls/sidebar and retains search, project filters, and pagination', async () => {
    const f = fixture();
    await f.flush();
    expect(f.all((n: any) => n.type === 'aside')).toHaveLength(0);
    expect(f.all((n: any) => /置顶/.test(f.text(n)))).toHaveLength(0);
    expect(f.tiles()).toHaveLength(2);
    await f.edit('搜索备忘录', '目标标签');
    expect(f.tiles()).toHaveLength(1);
    await f.edit('搜索备忘录', '');
    await f.click('生活');
    expect(f.tiles()).toHaveLength(1);
    await f.click('所有内容');
    await f.click('加载更多');
    expect(f.tiles()).toHaveLength(3);
  });
  it('keeps changed titles searchable and local drafts recoverable after closing and reopening', async () => {
    const f = fixture();
    await f.flush();
    await f.click('编辑：第二条');
    await f.edit('备忘录内容', '新草稿标题\n尚未同步');
    await f.click('关闭编辑器');
    await f.edit('搜索备忘录', '新草稿标题');
    expect(f.tiles()).toHaveLength(1);
    expect(f.text(f.tiles()[0])).toContain('未同步');
    await f.click('编辑：新草稿标题');
    expect(f.named('备忘录内容').props.value).toBe('新草稿标题\n尚未同步');
    expect(
      JSON.parse(localStorage.getItem(draftKey('https://fixture.test/test', 'b'))!).revision,
    ).toBe(3);
  });
  it('keeps the initial grid visible and applies native inert without React-version-specific boolean props', async () => {
    localStorage.setItem('dogo.memo.selection.https://fixture.test/test', JSON.stringify('b'));
    const f = fixture();
    await f.flush();
    expect(f.all((n: any) => n.props.role === 'dialog')).toHaveLength(0);
    const background = () => f.all((n: any) => n.props.className === 'dg-memo-browser')[0];
    const element = { inert: false };
    background().props.ref(element);
    expect(element.inert).toBe(false);
    await f.click('编辑：第二条');
    background().props.ref(element);
    expect(element.inert).toBe(true);
    await f.click('关闭编辑器');
    background().props.ref(element);
    expect(element.inert).toBe(false);
  });
  it('retains memory drafts across close/reopen when browser storage fails', async () => {
    const f = fixture();
    await f.flush();
    await f.click('编辑：第二条');
    vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw Error('quota');
    });
    await f.edit('备忘录内容', '存储失败时仍保留的草稿');
    await f.click('关闭编辑器');
    expect(f.tiles().some((n: any) => f.text(n).includes('存储失败时仍保留的草稿'))).toBe(true);
    await f.click('编辑：存储失败时仍保留的草稿');
    expect(f.named('备忘录内容').props.value).toBe('存储失败时仍保留的草稿');
    expect(f.props.setError).toHaveBeenCalled();
  });
  it('does not invent a server project filter from an unsubmitted project change', async () => {
    const f = fixture();
    await f.flush();
    await f.click('编辑：第二条');
    await f.click('属性');
    await f.edit('项目', 'new');
    await f.edit('新项目名称', '尚未提交的新项目');
    await f.click('关闭编辑器');
    const chips = f.all((n: any) => n.props.className?.includes('dg-filter-chip'));
    expect(chips.some((n: any) => f.text(n) === '尚未提交的新项目')).toBe(false);
    expect(f.tiles().some((n: any) => f.text(n).includes('尚未提交的新项目'))).toBe(true);
  });
  it('selects or creates a project while preserving the legacy category in saves', async () => {
    const f = fixture();
    await f.flush();
    await f.click('编辑：第一条');
    expect(f.named('项目').type).toBe('select');
    await f.edit('项目', JSON.stringify('生活'));
    await f.click('保存');
    expect(f.control).toHaveBeenCalledWith(
      'submit',
      expect.objectContaining({
        method: 'update',
        data: expect.objectContaining({ project: '生活', category: '原分类' }),
      }),
    );
    await f.edit('项目', 'new');
    await f.edit('新项目名称', '新项目');
    await f.click('关闭编辑器');
    await f.click('编辑：第一条');
    expect(f.named('项目').props.value).toBe(JSON.stringify('新项目'));
    await f.click('保存');
    expect(f.control).toHaveBeenCalledWith(
      'submit',
      expect.objectContaining({
        method: 'update',
        data: expect.objectContaining({ project: '新项目', category: '原分类' }),
      }),
    );
  });
  it('explains the current instruction limitation on already-saved notes without adding a fake send action', async () => {
    const f = fixture();
    await f.flush();
    await f.click('编辑：第二条');
    expect(
      f.all((n: any) => n.type === 'p' && f.text(n).includes('仅支持新建备忘录时附带 AI 指令')),
    ).toHaveLength(1);
    expect(f.named('执行指令')).toBeUndefined();
    expect(f.named('保存并发送')).toBeUndefined();
  });
  it('preserves single-click delete with original revision and does not ask for confirmation', async () => {
    const f = fixture();
    await f.flush();
    await f.click('编辑：第二条');
    await f.click('删除备忘录');
    expect(f.control).toHaveBeenCalledWith('submit', {
      method: 'delete',
      id: 'b',
      data: { revision: 3 },
    });
    expect(f.props.confirmAction).not.toHaveBeenCalled();
    expect(f.all((n: any) => n.props.role === 'dialog')).toHaveLength(0);
  });
  it('retains pending content and revision, locks saves/deletes and exposes pending state when closed', async () => {
    const f = fixture();
    await f.flush();
    await f.click('编辑：第二条');
    await f.edit('备忘录内容', '冲突输入');
    f.setFailure();
    await f.click('保存');
    expect(f.pending().data.revision).toBe(3);
    expect(f.pending().data.content).toBe('冲突输入');
    expect(f.named('保存').props.disabled).toBe(true);
    expect(f.named('删除备忘录').props.disabled).toBe(true);
    await f.click('查看服务器内容');
    expect(f.all((n: any) => n.type === 'small' && f.text(n).includes('版本 3'))).toHaveLength(1);
    await f.click('重试原写入');
    expect(f.pending().data.revision).toBe(3);
    await f.click('关闭编辑器');
    expect(f.named('查看待确认写入')).toBeTruthy();
    await f.click('查看待确认写入');
    await f.click('核对后清除');
    expect(f.props.confirmAction).toHaveBeenCalled();
  });
  it('does not revive a new draft or hide server success when cache removal throws', async () => {
    const f = fixture();
    await f.flush();
    await f.click('新建备忘');
    await f.edit('备忘录内容', '已确认的新内容');
    vi.spyOn(localStorage, 'removeItem').mockImplementation(() => {
      throw Error('storage disabled');
    });
    await f.click('保存');
    await f.click('关闭编辑器');
    expect(f.tiles().filter((n: any) => f.text(n).includes('已确认的新内容'))).toHaveLength(1);
    expect(f.props.notify).toHaveBeenCalledWith('已保存到 DogO');
    expect(f.props.setError).toHaveBeenCalled();
  });
  it('keeps new draft content and attached instructions through drawer close and submits the original create ID', async () => {
    const f = fixture();
    await f.flush();
    await f.click('新建备忘');
    await f.edit('备忘录内容', '新内容');
    await f.click('添加指令');
    await f.edit('执行指令', '请整理');
    await f.edit('目标设备', 'device');
    const saved = JSON.parse(localStorage.getItem(draftKey('https://fixture.test/test'))!);
    await f.click('关闭编辑器');
    await f.click('编辑：新内容');
    expect(f.named('执行指令').props.value).toBe('请整理');
    await f.click('保存并发送');
    expect(f.control).toHaveBeenCalledWith(
      'submit',
      expect.objectContaining({
        method: 'create',
        data: expect.objectContaining({
          request_id: saved.request_id,
          dispatch: { instruction: '请整理', target_device_id: 'device' },
        }),
      }),
    );
  });
});
