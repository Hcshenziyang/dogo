import {
  blankMemo,
  dateLabel,
  deliveryLabels,
  draftKey,
  memoExcerpt,
  memoTitle,
  readLocal,
  writeLocal,
  type Dict,
} from '../shared/presentation.js';

import { memoProjectTone, memoWithDraft, visibleMemos } from './presentation.js';

export function createMemosView(React: any, ui: any) {
  const { h, Icon, Button, Badge, Field, Empty, Markdown } = ui;
  return function Memos({
    control,
    status,
    devices,
    run,
    busy,
    setError,
    notify,
    confirmAction,
    openSettings,
  }: any) {
    const identity = status.server + '/' + status.username;
    const [sort, setSort] = React.useState('updated');
    const [items, setItems] = React.useState([] as Dict[]),
      [cursor, setCursor] = React.useState('');
    const [project, setProject] = React.useState(''),
      [search, setSearch] = React.useState('');
    const [projects, setProjects] = React.useState([] as string[]),
      [loading, setLoading] = React.useState(true);
    const [draft, setDraft] = React.useState(null as Dict | null),
      [detail, setDetail] = React.useState(false);
    const [properties, setProperties] = React.useState(false),
      [preview, setPreview] = React.useState(false);
    const [projectCreating, setProjectCreating] = React.useState(false);
    const [dispatchOpen, setDispatchOpen] = React.useState(false),
      [pending, setPending] = React.useState(null as Dict | null);
    const [comparison, setComparison] = React.useState(null as Dict | null),
      [localSaved, setLocalSaved] = React.useState(true);
    const current = React.useRef(null as Dict | null),
      mounted = React.useRef(true),
      request = React.useRef(0);
    const editor = React.useRef(null);
    const newProjectInput = React.useRef(null as HTMLInputElement | null);
    const panel = React.useRef(null as HTMLElement | null);
    const searchInput = React.useRef(null as HTMLInputElement | null);
    const newButton = React.useRef(null as HTMLButtonElement | null);
    const returnFocus = React.useRef(null as HTMLElement | null);
    const restoreFocus = React.useRef(false);
    const memoryDrafts = React.useRef(new Map<string, Dict | null>());
    const localDraft = (id = 'new') =>
      memoryDrafts.current.has(id)
        ? memoryDrafts.current.get(id)
        : readLocal(draftKey(identity, id));
    const forgetDraft = (id = 'new') => {
      // A tombstone prevents a stale cache from reviving during this page session.
      memoryDrafts.current.set(id, null);
      try {
        localStorage.removeItem(draftKey(identity, id));
      } catch {
        setError('服务器操作已确认，但本机旧草稿未能清理；重新打开页面前请检查浏览器存储。');
      }
    };
    const rememberFocus = () => {
      const active = document.activeElement as HTMLElement | null;
      if (active && !panel.current?.contains(active)) returnFocus.current = active;
    };
    const closeEditor = () => {
      if (busy) return;
      setDetail(false);
      restoreFocus.current = true;
    };
    React.useEffect(() => {
      if (detail) panel.current?.focus();
      else if (!busy && restoreFocus.current) {
        restoreFocus.current = false;
        requestAnimationFrame(() => {
          const target = returnFocus.current;
          if (target?.isConnected && !target.closest('[inert]') && !target.hasAttribute('disabled'))
            target.focus();
          else newButton.current?.focus();
        });
      }
    }, [detail, busy]);
    React.useEffect(() => {
      if (projectCreating) requestAnimationFrame(() => newProjectInput.current?.focus());
    }, [projectCreating]);
    const storeDraft = (value: Dict) => {
      current.current = value;
      memoryDrafts.current.set(value.id || 'new', value);
      setDraft(value);
      try {
        writeLocal(draftKey(identity, value.id || 'new'), value);
        writeLocal('dogo.memo.selection.' + identity, value.id || 'new');
        setLocalSaved(true);
      } catch (e) {
        setLocalSaved(false);
        setError((e as Error).message);
      }
    };
    const update = (change: Dict) => {
      if (current.current) storeDraft({ ...current.current, ...change, dirty: true });
    };
    const list = async (filter = project, more = false) => {
      const sequence = ++request.current;
      setLoading(true);
      try {
        const result = await control('list', {
          project: filter,
          ...(more && cursor ? { cursor } : {}),
        });
        if (!mounted.current || sequence !== request.current) return;
        setItems((old: Dict[]) =>
          more
            ? [
                ...old.filter((m) => !result.items.some((n: Dict) => n.id === m.id)),
                ...result.items,
              ]
            : result.items,
        );
        setCursor(result.next_cursor || '');
        setProjects((old: string[]) =>
          [
            ...new Set([...old, ...result.items.map((m: Dict) => m.project).filter(Boolean)]),
          ].sort(),
        );
        return result.items;
      } finally {
        if (mounted.current && sequence === request.current) setLoading(false);
      }
    };
    const select = async (memo: Dict, open = true) => {
      rememberFocus();
      const saved = localDraft(memo.id);
      const value = saved?.dirty ? saved : await control('get', { id: memo.id });
      if (!mounted.current) return;
      storeDraft(value);
      setDetail(open);
      setPreview(false);
      setProperties(false);
      setProjectCreating(false);
      setDispatchOpen(false);
    };
    const newMemo = () => {
      rememberFocus();
      const value = localDraft() || {
        ...blankMemo(),
        project,
        instruction: '',
        destination: '',
      };
      storeDraft(value);
      setDetail(true);
      setPreview(false);
      setProperties(false);
      setProjectCreating(false);
      setDispatchOpen(!!value.instruction);
      requestAnimationFrame(() => editor.current?.focus());
    };
    React.useEffect(() => {
      mounted.current = true;
      void run(async () => {
        setPending(await control('pending'));
        const previous = readLocal('dogo.draft.' + identity + '.');
        if (previous && !readLocal('dogo.draft.imported.' + identity)) {
          if (!readLocal(draftKey(identity, previous.id || 'new')))
            writeLocal(draftKey(identity, previous.id || 'new'), { ...previous, dirty: true });
          writeLocal('dogo.draft.imported.' + identity, true);
        }
        const records = await list('');
        if (!mounted.current) return;
        const local = localDraft();
        const last = readLocal('dogo.memo.selection.' + identity);
        const remembered = records?.find((m: Dict) => m.id === last);
        if (remembered) {
          await select(remembered, false);
        } else if (local?.content || local?.instruction) {
          storeDraft(local);
          setDetail(false);
          setDispatchOpen(!!local.instruction);
        } else if (records?.length) {
          await select([...records].sort((a: Dict, b: Dict) => b.updated_at - a.updated_at)[0]);
          setDetail(false);
        }
      });
      return () => {
        mounted.current = false;
        request.current++;
      };
    }, []);
    const save = async () => {
      const value = current.current;
      if (
        !value ||
        pending ||
        !value.content.trim() ||
        (!value.id && value.instruction?.trim() && !value.destination)
      )
        return;
      const data = {
        content: value.content,
        project: value.project,
        category: value.category,
        tags: (value.tagText ?? value.tags?.join(',') ?? '')
          .split(/[,，]/)
          .map((v: string) => v.trim())
          .filter(Boolean),
        active: value.active,
      };
      const op = value.id
        ? { method: 'update', id: value.id, data: { ...data, revision: value.revision } }
        : {
            method: 'create',
            data: {
              ...data,
              request_id: value.request_id,
              ...(value.instruction?.trim()
                ? {
                    dispatch: {
                      instruction: value.instruction,
                      target_device_id: value.destination,
                    },
                  }
                : {}),
            },
          };
      try {
        const result = await control('submit', op);
        if (!value.id) {
          forgetDraft();
        }
        storeDraft({ ...result, dirty: false });
        setDispatchOpen(false);
        notify(
          result.dispatch?.status === 'pending'
            ? '备忘录已保存，指令等待设备接收'
            : '已保存到 DogO',
        );
        await list();
      } finally {
        setPending(await control('pending'));
      }
    };
    React.useEffect(() => {
      const handler = (e: KeyboardEvent) => {
        if (
          detail &&
          (e.metaKey || e.ctrlKey) &&
          (e.key.toLowerCase() === 's' || e.key === 'Enter')
        ) {
          e.preventDefault();
          if (!busy && !(document.activeElement as HTMLElement | null)?.closest('.dg-dialog'))
            void run(save);
        }
      };
      window.addEventListener('keydown', handler);
      return () => window.removeEventListener('keydown', handler);
    });
    const remove = async () => {
      const value = current.current;
      if (!value?.id || pending) return;
      try {
        await control('submit', {
          method: 'delete',
          id: value.id,
          data: { revision: value.revision },
        });
        forgetDraft(value.id);
        current.current = null;
        setDraft(null);
        setDetail(false);
        returnFocus.current = null;
        restoreFocus.current = true;
        await list();
        notify('备忘录已删除');
      } finally {
        setPending(await control('pending'));
      }
    };
    const displayItems = items.map((m: Dict) => memoWithDraft(m, localDraft(m.id)));
    const newDraft = localDraft();
    if (
      (newDraft?.content?.trim() || newDraft?.instruction?.trim()) &&
      (!project || newDraft.project === project)
    )
      displayItems.unshift({ ...newDraft, dirty: true });
    const filtered = visibleMemos(displayItems, search, sort);
    // Chips describe persisted server projects, not unsubmitted draft metadata.
    const filterProjects = projects;
    const memo = draft;
    const pendingView =
      pending &&
      h(
        'section',
        { className: 'dg-conflict' },
        h('h3', null, '上一笔写入需要确认'),
        h('p', null, '内容已保留。网络中断时可能已保存成功；版本冲突时请先核对，不会自动覆盖。'),
        h(
          'div',
          { className: 'dg-compare' },
          h(
            'div',
            null,
            h('small', null, pending.method === 'delete' ? '等待确认的操作' : '原写入内容'),
            h('pre', null, pending.method === 'delete' ? '删除备忘录' : pending.data?.content),
            h('small', null, pending.data?.project ? '项目：' + pending.data.project : ''),
          ),
          comparison &&
            h(
              'div',
              null,
              h('small', null, '服务器当前内容 · 版本 ' + comparison.revision),
              h('pre', null, comparison.content),
            ),
        ),
        h(
          'div',
          { className: 'dg-row', style: { flexWrap: 'wrap' } },
          h(
            Button,
            {
              variant: 'secondary',
              disabled: busy,
              onClick: () =>
                void run(async () => {
                  try {
                    const result = await control('retry');
                    if (pending.method === 'delete') {
                      if (pending.id) {
                        forgetDraft(pending.id);
                      }
                      setDraft(null);
                      current.current = null;
                    } else {
                      if (pending.method === 'create') {
                        forgetDraft();
                      }
                      storeDraft({ ...result, dirty: false });
                    }
                    setComparison(null);
                    await list();
                    notify('原写入已确认');
                  } finally {
                    setPending(await control('pending'));
                  }
                }),
            },
            '重试原写入',
          ),
          pending.id &&
            h(
              Button,
              {
                disabled: busy,
                onClick: () =>
                  void run(async () => setComparison(await control('get', { id: pending.id }))),
              },
              '查看服务器内容',
            ),
          h(
            Button,
            {
              disabled: busy,
              onClick: () =>
                confirmAction(
                  '清除待确认记录？',
                  '这只解除本机的写入锁定，不撤销服务器上可能已完成的操作。编辑草稿会保留，请核对后再继续。',
                  async () => {
                    await control('discard');
                    setPending(null);
                    setComparison(null);
                  },
                  '已核对，清除记录',
                ),
            },
            '核对后清除',
          ),
        ),
      );
    const chooseProject = (next: string) => {
      setProject(next);
      void run(() => list(next));
    };
    return h(
      'div',
      {
        className: 'dg-memos-layout dg-memo-workspace',
        onKeyDown: (e: any) => {
          if (detail || e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
          const target = e.target as HTMLElement;
          if (target.closest('input,textarea,select,[contenteditable=true]')) return;
          e.preventDefault();
          searchInput.current?.focus();
        },
      },
      h(
        'div',
        {
          className: 'dg-memo-browser',
          ref: (node: HTMLElement | null) => {
            if (node) node.inert = detail;
          },
          'aria-hidden': detail || undefined,
        },
        h(
          'div',
          { className: 'dg-memo-toolbar' },
          h(
            'label',
            { className: 'dg-search' },
            h(Icon, { name: 'search', size: 16 }),
            h('input', {
              ref: searchInput,
              type: 'search',
              'aria-label': '搜索备忘录',
              placeholder: cursor ? '搜索已加载的备忘录' : '搜索标题、内容或标签',
              value: search,
              onChange: (e: any) => setSearch(e.target.value),
              onKeyDown: (e: any) => {
                if (e.key === 'Escape') {
                  e.preventDefault();
                  setSearch('');
                }
              },
            }),
          ),
          h(
            'button',
            {
              ref: newButton,
              type: 'button',
              className: 'dg-button dg-primary',
              disabled: busy,
              onClick: newMemo,
            },
            h(Icon, { name: 'plus', size: 16 }),
            '新建备忘',
          ),
          h(Button, {
            icon: 'refresh',
            'aria-label': '刷新备忘录',
            disabled: busy,
            onClick: () =>
              void run(async () => {
                await list();
                setPending(await control('pending'));
              }),
          }),
          h(Button, { icon: 'settings', 'aria-label': 'DogO 设置', onClick: openSettings }),
        ),
        h(
          'div',
          { className: 'dg-memo-filters', 'aria-label': '内容与项目筛选' },
          h(
            Button,
            {
              className: 'dg-filter-chip',
              'aria-pressed': !project,
              disabled: busy,
              onClick: () => {
                chooseProject('');
              },
            },
            '所有内容',
          ),
          ...filterProjects.map((p: string) =>
            h(
              Button,
              {
                key: p,
                className: 'dg-filter-chip',
                'aria-pressed': project === p,
                disabled: busy,
                onClick: () => chooseProject(project === p ? '' : p),
              },
              p,
            ),
          ),
          h(
            'select',
            {
              className: 'dg-memo-sort',
              'aria-label': '排序方式',
              value: sort,
              onChange: (e: any) => setSort(e.target.value),
            },
            h('option', { value: 'updated' }, '按最近编辑排序'),
            h('option', { value: 'created' }, '按创建时间排序'),
            h('option', { value: 'title' }, '按标题排序'),
          ),
        ),
        pending &&
          h(
            'div',
            { className: 'dg-memo-pending-banner', role: 'status' },
            h('span', null, '上一笔写入需要核对，已暂停提交。'),
            h(
              Button,
              {
                disabled: busy,
                onClick: () => {
                  rememberFocus();
                  setDetail(true);
                },
              },
              '查看待确认写入',
            ),
          ),
        h(
          'div',
          { className: 'dg-memo-grid', 'aria-label': '备忘录方格', 'aria-busy': loading },
          loading && !items.length
            ? [1, 2, 3].map((n) =>
                h('div', { key: n, className: 'dg-skeleton', 'aria-label': '正在加载' }),
              )
            : filtered.map((m: Dict) =>
                h(
                  'button',
                  {
                    type: 'button',
                    key: m.id || 'draft:' + m.request_id,
                    className: 'dg-memo-tile',
                    'aria-current': memo?.id === m.id && !!m.id,
                    'data-tone': memoProjectTone(m.project),
                    'aria-label': '编辑：' + memoTitle(m.content),
                    disabled: busy,
                    onClick: () => (m.id ? void run(() => select(m)) : newMemo()),
                  },
                  h(
                    'div',
                    { className: 'dg-memo-tile-top' },
                    h(
                      'span',
                      { className: 'dg-memo-project', title: m.project || '未分类' },
                      m.project || '未分类',
                    ),
                    m.dirty && h('span', { className: 'dg-small dg-muted' }, '未同步'),
                  ),
                  h('h3', { className: 'dg-memo-tile-title' }, memoTitle(m.content)),
                  h('p', { className: 'dg-memo-tile-excerpt' }, memoExcerpt(m.content)),
                  h(
                    'div',
                    { className: 'dg-memo-tile-foot' },
                    h('time', null, m.id ? dateLabel(m.updated_at) : '本机新草稿'),
                    m.dispatch &&
                      h(
                        Badge,
                        { tone: m.dispatch.status === 'accepted' ? 'good' : 'warning' },
                        deliveryLabels[m.dispatch.status] || '等待确认',
                      ),
                  ),
                ),
              ),
          !loading &&
            !filtered.length &&
            h(
              Empty,
              {
                title: search ? '没有找到匹配备忘' : '这里还没有备忘',
              },
              cursor
                ? '当前只搜索已加载记录，可以继续加载更多。'
                : '试试其他关键词，或新建一条备忘。',
            ),
          !search &&
            h(
              'button',
              {
                type: 'button',
                className: 'dg-memo-tile dg-memo-new-tile',
                disabled: busy,
                onClick: newMemo,
              },
              h(Icon, { name: 'plus', size: 24 }),
              '记下一个新想法',
            ),
        ),
        h(
          'div',
          { className: 'dg-memo-grid-footer' },
          h(
            'span',
            { role: 'status' },
            filtered.length + ' 条显示 · ' + items.length + (cursor ? '+ 条已加载' : ' 条在线记录'),
          ),
          cursor &&
            h(
              Button,
              { disabled: busy, onClick: () => void run(() => list(project, true)) },
              '加载更多',
            ),
        ),
      ),
      detail &&
        h(
          'div',
          {
            className: 'dg-memo-overlay',
            onMouseDown: (e: any) => {
              if (e.target === e.currentTarget) closeEditor();
            },
          },
          h(
            'section',
            {
              className: 'dg-editor dg-memo-panel',
              ref: panel,
              role: 'dialog',
              'aria-modal': true,
              'aria-label': '备忘录编辑器',
              tabIndex: -1,
              onKeyDown: (e: any) => {
                if (e.key === 'Escape') {
                  e.preventDefault();
                  e.stopPropagation();
                  closeEditor();
                }
                if (e.key !== 'Tab') return;
                const nodes = (panel.current as HTMLElement | null)?.querySelectorAll<HTMLElement>(
                  'button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),a[href],[tabindex="0"]',
                );
                const focusable = Array.from(nodes || []).filter(
                  (node) => node.getClientRects().length,
                );
                const first = focusable[0],
                  last = focusable[focusable.length - 1];
                if (!first) {
                  e.preventDefault();
                  panel.current?.focus();
                } else if (
                  e.shiftKey &&
                  (document.activeElement === first || document.activeElement === panel.current)
                ) {
                  e.preventDefault();
                  last.focus();
                } else if (
                  !e.shiftKey &&
                  (document.activeElement === last || document.activeElement === panel.current)
                ) {
                  e.preventDefault();
                  first.focus();
                }
              },
            },
            h(
              'div',
              { className: 'dg-memo-panel-head' },
              h('span', null, memo?.id ? '编辑备忘' : '新建备忘'),
              h(Button, {
                icon: 'close',
                'aria-label': '关闭编辑器',
                disabled: busy,
                onClick: closeEditor,
              }),
            ),
            pendingView,
            !memo
              ? h(
                  Empty,
                  {
                    title: '留住此刻的想法',
                    icon: 'edit',
                    action: h(
                      Button,
                      { variant: 'primary', icon: 'plus', disabled: busy, onClick: newMemo },
                      '新建备忘录',
                    ),
                  },
                  '记录文字或链接，保存后就能在其他设备继续，也可以交给你的电脑处理。',
                )
              : h(
                  React.Fragment,
                  null,
                  h(
                    'div',
                    { className: 'dg-editor-tools' },
                    h(
                      'div',
                      { className: 'dg-row' },
                      h(
                        'div',
                        { className: 'dg-tabs', 'aria-label': '编辑模式' },
                        h(
                          Button,
                          {
                            className: !preview ? 'dg-selected' : '',
                            'aria-pressed': !preview,
                            onClick: () => setPreview(false),
                          },
                          '编辑',
                        ),
                        h(
                          Button,
                          {
                            className: preview ? 'dg-selected' : '',
                            'aria-pressed': preview,
                            onClick: () => setPreview(true),
                          },
                          '阅读',
                        ),
                      ),
                    ),
                    h(
                      'div',
                      { className: 'dg-row' },
                      h(Button, {
                        icon: 'tag',
                        title: '更多属性：标签与启用状态',
                        'aria-label': '属性',
                        'aria-expanded': properties,
                        className: properties ? 'dg-selected' : '',
                        onClick: () => setProperties(!properties),
                      }),
                      memo.id &&
                        h(Button, {
                          icon: 'refresh',
                          'aria-label': '重新读取服务器内容',
                          title: '重新读取服务器内容',
                          disabled: busy || !!pending,
                          onClick: () =>
                            confirmAction(
                              '重新读取服务器内容？',
                              '服务器当前内容将替换此处的本机编辑草稿。请先复制需要保留的文字；此操作不会向服务器写入。',
                              async () => {
                                storeDraft({
                                  ...(await control('get', { id: memo.id })),
                                  dirty: false,
                                });
                                notify('已读取服务器当前内容');
                              },
                              '重新读取',
                            ),
                        }),
                      memo.id &&
                        h(Button, {
                          icon: 'trash',
                          'aria-label': '删除备忘录',
                          disabled: busy || !!pending,
                          onClick: () => void run(remove),
                        }),
                      h(
                        Button,
                        {
                          variant: 'primary',
                          icon: 'check',
                          disabled:
                            busy ||
                            !!pending ||
                            !memo.content.trim() ||
                            (!memo.id &&
                              !!memo.instruction?.trim() &&
                              (!memo.destination || !memo.active)),
                          onClick: () => void run(save),
                        },
                        busy
                          ? '处理中…'
                          : !memo.id && memo.instruction?.trim()
                            ? '保存并发送'
                            : '保存',
                      ),
                    ),
                  ),
                  h(
                    'div',
                    { className: 'dg-editor-scroll' },
                    h(
                      'div',
                      { className: 'dg-memo-project-field' },
                      h(
                        'label',
                        { className: 'dg-field' },
                        h('span', null, '项目'),
                        h(
                          'select',
                          {
                            'aria-label': '项目',
                            value: projectCreating ? 'new' : JSON.stringify(memo.project || ''),
                            disabled: busy,
                            onChange: (e: any) => {
                              if (e.target.value === 'new') {
                                setProjectCreating(true);
                                update({ project: '' });
                              } else {
                                setProjectCreating(false);
                                update({ project: JSON.parse(e.target.value) });
                              }
                            },
                          },
                          h('option', { value: JSON.stringify('') }, '未分类'),
                          ...[...new Set([...projects, memo.project].filter(Boolean))].map(
                            (name: any) =>
                              h('option', { key: name, value: JSON.stringify(name) }, name),
                          ),
                          h('option', { value: 'new' }, '＋ 新项目…'),
                        ),
                      ),
                      projectCreating &&
                        h(
                          'label',
                          { className: 'dg-field' },
                          h('span', null, '新项目名称'),
                          h('input', {
                            ref: newProjectInput,
                            'aria-label': '新项目名称',
                            placeholder: '输入名称，保存备忘录时使用',
                            value: memo.project,
                            maxLength: 100,
                            disabled: busy,
                            onChange: (e: any) => update({ project: e.target.value }),
                          }),
                        ),
                      h(
                        'small',
                        { className: 'dg-muted' },
                        projectCreating
                          ? '随备忘录一起保存，不单独创建空项目。'
                          : '从已加载项目选择，也可以输入新名称。',
                      ),
                    ),
                    properties &&
                      h(
                        'div',
                        { className: 'dg-properties' },
                        memo.category &&
                          h(
                            'p',
                            { className: 'dg-small dg-muted dg-span' },
                            '原分类：' + memo.category + '（保留，不与项目合并）',
                          ),
                        h(
                          'div',
                          { className: 'dg-span' },
                          h(Field, {
                            label: '标签',
                            hint: '使用逗号分隔',
                            placeholder: '待整理, 产品',
                            value: memo.tagText ?? (memo.tags || []).join(', '),
                            disabled: busy,
                            onChange: (e: any) => update({ tagText: e.target.value }),
                          }),
                        ),
                        h(
                          'label',
                          { className: 'dg-check dg-span' },
                          h('input', {
                            type: 'checkbox',
                            checked: memo.active,
                            disabled: busy,
                            onChange: (e: any) => update({ active: e.target.checked }),
                          }),
                          '启用这条备忘录',
                        ),
                      ),
                    (!!memo.tags?.length || !memo.active) &&
                      h(
                        'div',
                        { className: 'dg-editor-meta' },
                        ...(memo.tags || [])
                          .slice(0, 4)
                          .map((tag: string) =>
                            h('span', { className: 'dg-chip', key: tag }, '# ' + tag),
                          ),
                        !memo.active && h(Badge, {}, '已停用'),
                      ),
                    h(
                      'div',
                      { className: 'dg-paper' },
                      preview
                        ? memo.content
                          ? h(Markdown, { text: memo.content })
                          : h('p', { className: 'dg-muted' }, '写下内容后，在这里阅读。')
                        : h('textarea', {
                            ref: editor,
                            'aria-label': '备忘录内容',
                            placeholder:
                              '此刻，想记下什么？\n\n第一行可以写个标题。\n想法、链接、待办，都从这里开始。',
                            value: memo.content,
                            disabled: busy,
                            maxLength: 256000,
                            onChange: (e: any) => update({ content: e.target.value }),
                          }),
                    ),
                    !memo.id &&
                      h(
                        'section',
                        { className: 'dg-dispatch' },
                        h(
                          'div',
                          { className: 'dg-row dg-row-between' },
                          h(
                            'div',
                            { className: 'dg-row' },
                            h(Icon, { name: 'send', size: 16 }),
                            h('span', { className: 'dg-small' }, '交给电脑处理'),
                          ),
                          h(
                            Button,
                            {
                              disabled: busy,
                              'aria-expanded': dispatchOpen,
                              onClick: () => setDispatchOpen(!dispatchOpen),
                            },
                            dispatchOpen ? '收起' : '添加指令',
                          ),
                        ),
                        dispatchOpen &&
                          h(
                            React.Fragment,
                            null,
                            h('textarea', {
                              'aria-label': '执行指令',
                              placeholder: '例如：阅读这篇文章，整理要点并追加到备忘录。',
                              value: memo.instruction || '',
                              disabled: busy,
                              maxLength: 32000,
                              onChange: (e: any) => update({ instruction: e.target.value }),
                            }),
                            h(
                              'select',
                              {
                                'aria-label': '目标设备',
                                value: memo.destination || '',
                                disabled: busy,
                                onChange: (e: any) => update({ destination: e.target.value }),
                              },
                              h('option', { value: '' }, '选择执行电脑'),
                              ...devices
                                .filter((d: Dict) => d.kind === 'desktop' && d.active)
                                .map((d: Dict) =>
                                  h(
                                    'option',
                                    { key: d.id, value: d.id },
                                    d.name + (d.online ? ' · 在线' : ' · 离线，待上线后执行'),
                                  ),
                                ),
                            ),
                            h(
                              'p',
                              { className: 'dg-small dg-muted' },
                              '保存时新建会话。电脑离线也可以发送，上线后自动接收。',
                            ),
                          ),
                      ),
                    memo.id &&
                      !memo.dispatch &&
                      h(
                        'section',
                        { className: 'dg-dispatch' },
                        h(
                          'p',
                          { className: 'dg-small dg-muted' },
                          '当前版本仅支持新建备忘录时附带 AI 指令。这条备忘录已保存，编辑不会发送指令。',
                        ),
                      ),
                    memo.dispatch &&
                      h(
                        'section',
                        { className: 'dg-dispatch' },
                        h(
                          'div',
                          { className: 'dg-row dg-row-between' },
                          h(
                            'span',
                            { className: 'dg-small' },
                            '交给 ' +
                              (devices.find((d: Dict) => d.id === memo.dispatch.target_device_id)
                                ?.name || '指定设备'),
                          ),
                          h(
                            Badge,
                            { tone: memo.dispatch.status === 'accepted' ? 'good' : 'warning' },
                            deliveryLabels[memo.dispatch.status],
                          ),
                        ),
                        h('p', { className: 'dg-small' }, memo.dispatch.instruction),
                        h(
                          'p',
                          { className: 'dg-small dg-muted' },
                          '这条指令已提交，不能在此改写。修改备忘录不会改变本次投递，也不会再次发送。',
                        ),
                        h(
                          'p',
                          { className: 'dg-small dg-muted' },
                          '设备接收不代表执行完成，请到设备会话中查看进展。',
                        ),
                      ),
                  ),
                  h(
                    'footer',
                    { className: 'dg-editor-foot' },
                    h(
                      Badge,
                      {
                        tone: !localSaved
                          ? 'danger'
                          : memo.dirty
                            ? 'warning'
                            : memo.id
                              ? 'good'
                              : 'muted',
                      },
                      !localSaved
                        ? '草稿未能保存在本机'
                        : memo.dirty
                          ? '草稿已保存在本机 · 尚未同步'
                          : memo.id
                            ? '已保存到 DogO'
                            : '新备忘录',
                    ),
                    h(
                      'span',
                      null,
                      memo.content.length.toLocaleString() + ' 字',
                      memo.id && ' · ' + dateLabel(memo.updated_at),
                    ),
                  ),
                ),
          ),
        ),
    );
  };
}
