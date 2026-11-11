import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemosView } from '../memos/view.js';
import { createUI } from '../shared/ui.js';
import { draftKey } from '../shared/presentation.js';

// Deterministic hook/element harness. These are component-state tests, not browser layout tests.
function fixture(options: { localFirst?: boolean } = {}) {
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
      tags: ['原标签', '带,逗号'],
      active: true,
      revision: 4,
      ...(options.localFirst
        ? { remote_id: 'server-a', remote_revision: 4, sync_status: 'synced' }
        : {}),
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
      ...(options.localFirst ? { sync_status: 'local' } : {}),
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
      ...(options.localFirst ? { sync_status: 'conflict' } : {}),
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
      const prior = data.id ? records.find((m) => m.id === data.id) : undefined;
      const result = {
        ...prior,
        ...data.data,
        id: data.id || 'created',
        revision: 5,
        updated_at: 40,
      };
      records = [result, ...records.filter((m) => m.id !== result.id)];
      return result;
    }
    if (method === 'retry') {
      throw Error('still uncertain');
    }
  });
  const props: any = {
    control,
    status: options.localFirst
      ? {
          server: 'https://fixture.test',
          username: 'test',
          loggedIn: true,
          memoIdentity: 'account-a',
        }
      : { server: 'https://fixture.test', username: 'test' },
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
    setPending: (value: any) => {
      pending = value;
    },
    dispose: () => state.forEach((value) => value?.cleanup?.()),
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
  it('renders a simple grid with content search and pagination', async () => {
    const f = fixture();
    await f.flush();
    expect(f.all((n: any) => n.type === 'aside')).toHaveLength(0);
    expect(f.all((n: any) => /置顶/.test(f.text(n)))).toHaveLength(0);
    expect(f.tiles()).toHaveLength(2);
    expect(f.named('新建备忘')).toBeTruthy();
    expect(f.all((n: any) => n.props.className === 'dg-memo-tile dg-memo-new-tile')).toHaveLength(
      0,
    );
    expect(f.all((n: any) => /条显示|条本机记录|未登录，保存在本机/.test(f.text(n)))).toHaveLength(
      0,
    );
    await f.edit('搜索备忘录', '第二条');
    expect(f.tiles()).toHaveLength(1);
    await f.edit('搜索备忘录', '目标标签');
    expect(f.tiles()).toHaveLength(0);
    await f.edit('搜索备忘录', '');
    expect(f.all((n: any) => n.props.className === 'dg-memo-project')).toHaveLength(0);
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
    expect(f.tiles()[0].props['aria-description']).toBe('未同步，草稿未保存');
    await f.click('编辑：新草稿标题');
    expect(f.named('备忘录内容').props.value).toBe('新草稿标题\n尚未同步');
    expect(
      JSON.parse(localStorage.getItem(draftKey('https://fixture.test/test', 'b'))!).revision,
    ).toBe(3);
  });
  it('shows compact sync icons, retains pagination and identifies conflicts and unsaved drafts', async () => {
    localStorage.setItem(
      draftKey('local/account-a', 'c'),
      JSON.stringify({ id: 'c', content: '冲突草稿', dirty: true, sync_status: 'local' }),
    );
    const f = fixture({ localFirst: true });
    try {
      await f.flush();
      const synced = f.named('编辑：第一条');
      const local = f.named('编辑：第二条');
      expect(synced.props['aria-description']).toBe('已同步');
      expect(local.props['aria-description']).toBe('未同步');
      expect(f.all((n: any) => n.props.title === '已同步')).toHaveLength(1);
      expect(f.all((n: any) => n.props.title === '未同步')).toHaveLength(1);
      expect(f.text(local)).not.toContain('仅本机');
      await f.click('加载更多');
      expect(f.named('编辑：冲突草稿').props['aria-description']).toBe('同步冲突，草稿未保存');
      expect(f.all((n: any) => n.props.title === '同步冲突，草稿未保存')).toHaveLength(1);
      await f.click('编辑：第一条');
      await f.edit('备忘录内容', '修改后尚未保存');
      await f.click('关闭编辑器');
      expect(f.named('编辑：修改后尚未保存').props['aria-description']).toBe('未同步，草稿未保存');
    } finally {
      f.dispose();
    }
  });
  it('keeps synchronization errors discoverable without adding status text to the grid', async () => {
    const f = fixture({ localFirst: true });
    f.props.status.sync = { phase: 'needs-review', error: '请求失败' };
    try {
      await f.flush();
      expect(f.named('同步需要核对').props.title).toBe('同步需要核对：请求失败');
      expect(f.text(f.named('同步需要核对'))).toBe('');
    } finally {
      f.dispose();
    }
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
  it('hides project, category and tags while preserving their exact values when saving content', async () => {
    const f = fixture();
    await f.flush();
    await f.click('编辑：第一条');
    expect(f.named('项目')).toBeUndefined();
    expect(f.named('标签')).toBeUndefined();
    expect(f.all((n: any) => n.type === 'p' && f.text(n).includes('原分类'))).toHaveLength(0);
    await f.edit('备忘录内容', '只修改正文');
    await f.click('保存');
    expect(f.control).toHaveBeenCalledWith(
      'submit',
      expect.objectContaining({
        method: 'update',
        data: expect.objectContaining({
          content: '只修改正文',
          project: '工作',
          category: '原分类',
          tags: ['原标签', '带,逗号'],
        }),
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
  it('creates and edits a scheduled plan while retaining the original memo revision', async () => {
    const f = fixture();
    await f.flush();
    await f.click('新建备忘');
    await f.edit('备忘录内容', '定时记录');
    await f.click('添加定时任务');
    await f.edit('定时指令', '整理本周记录');
    await f.edit('定时目标电脑', 'device');
    await f.edit('执行频率', 'weekly');
    await f.edit('星期', '4');
    await f.edit('执行时刻', '08:30');
    await f.click('保存');
    expect(f.control).toHaveBeenCalledWith(
      'submit',
      expect.objectContaining({
        method: 'create',
        data: expect.objectContaining({
          content: '定时记录',
          plan: expect.objectContaining({
            mode: 'weekly',
            weekday: 4,
            time: '08:30',
            instruction: '整理本周记录',
            target_device_id: 'device',
          }),
        }),
      }),
    );
    await f.edit('备忘录内容', '修改正文');
    await f.click('保存');
    const calls = f.control.mock.calls.filter((c: any[]) => c[0] === 'submit');
    expect(calls.at(-1)![1].data).not.toHaveProperty('plan');
    await f.click('移除计划');
    await f.click('保存');
    const latest = f.control.mock.calls.filter((c: any[]) => c[0] === 'submit').at(-1)![1];
    expect(latest.data.plan).toBeNull();
    expect(latest.data.revision).toBe(5);
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
  it('distinguishes online, offline and unknown target device states', async () => {
    const f = fixture({ localFirst: true });
    f.props.devices = [
      { id: 'one', name: '在线电脑', kind: 'desktop', active: true, online: true },
      { id: 'two', name: '离线电脑', kind: 'desktop', active: true, online: false },
      { id: 'three', name: '未知电脑', kind: 'desktop', active: true },
    ];
    await f.flush();
    await f.click('新建备忘');
    await f.click('添加指令');
    const choices = f.all((n: any) => n.type === 'option').map((n: any) => f.text(n));
    expect(choices).toContain('在线电脑 · 在线');
    expect(choices).toContain('离线电脑 · 离线，待上线后执行');
    expect(choices).toContain('未知电脑 · 状态未知');
  });
  it('allows local editing while an older online write is awaiting review', async () => {
    const f = fixture({ localFirst: true });
    try {
      await f.flush();
      f.setPending({
        method: 'update',
        id: 'old-remote',
        data: { revision: 1, content: '待核对' },
      });
      await f.click('刷新备忘录');
      await f.click('编辑：第二条');
      await f.edit('备忘录内容', '本机仍可编辑');
      expect(f.named('保存').props.disabled).toBe(false);
      await f.click('保存');
      expect(f.control).toHaveBeenCalledWith(
        'submit',
        expect.objectContaining({ data: expect.objectContaining({ content: '本机仍可编辑' }) }),
      );
      expect(f.props.notify).toHaveBeenCalledWith('已保存到本机，等待同步');
    } finally {
      f.dispose();
    }
  });
  it('preserves an old server draft and requires a re-read when its base version differs', async () => {
    localStorage.setItem(
      draftKey('https://fixture.test/test', 'server-a'),
      JSON.stringify({
        id: 'server-a',
        revision: 2,
        content: '旧草稿内容',
        dirty: true,
        project: '',
        category: '',
        tags: [],
        active: true,
      }),
    );
    const f = fixture({ localFirst: true });
    try {
      await f.flush();
      await f.click('编辑：旧草稿内容');
      expect(f.named('备忘录内容').props.value).toBe('旧草稿内容');
      expect(f.named('保存').props.disabled).toBe(true);
      expect(
        f.all((n: any) => n.props.role === 'alert' && f.text(n).includes('旧草稿基于不同')),
      ).toHaveLength(1);
    } finally {
      f.dispose();
    }
  });
});
