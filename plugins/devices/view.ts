import {
  conversation,
  dateLabel,
  readLocal,
  writeLocal,
  type Dict,
} from '../shared/presentation.js';

export function createDevicesView(React: any, ui: any) {
  const { h, Icon, Button, Badge, Empty, Markdown, Field, Dialog } = ui;
  return function Devices({
    control,
    status,
    devices,
    refresh,
    run,
    busy,
    setError,
    notify,
    confirmAction,
    openSettings,
  }: any) {
    const identity = status.server + '/' + status.username;
    const key = (type: string, tail = '') => 'dogo.' + type + '.' + identity + '.' + tail;
    const [target, setTarget] = React.useState(''),
      [sessions, setSessions] = React.useState([] as Dict[]);
    const [session, setSession] = React.useState(''),
      [cursor, setCursor] = React.useState('');
    const [snapshot, setSnapshot] = React.useState(null as Dict | null),
      [message, setMessage] = React.useState('');
    const [unknown, setUnknown] = React.useState(false),
      [creating, setCreating] = React.useState(false);
    const [loading, setLoading] = React.useState(false),
      [detail, setDetail] = React.useState(false);
    const [snapshotError, setSnapshotError] = React.useState('');
    const [workspaces, setWorkspaces] = React.useState([] as Dict[]),
      [catalog, setCatalog] = React.useState(null as Dict | null);
    const [projectFilter, setProjectFilter] = React.useState(''),
      [optionsError, setOptionsError] = React.useState('');
    const [createOpen, setCreateOpen] = React.useState(false),
      [newProject, setNewProject] = React.useState('');
    const isOnline = (d: Dict) =>
      d.id === status.deviceId ? !!status.consumer?.online : !!d.online;
    const selected = devices.find((d: Dict) => d.id === target),
      online = !!selected?.active && isOnline(selected) && selected.kind === 'desktop';
    const mounted = React.useRef(true),
      generation = React.useRef(0),
      scroll = React.useRef(null),
      bottom = React.useRef(true);
    const selectedRef = React.useRef(''),
      sessionRef = React.useRef(''),
      modelRevision = React.useRef(0);
    selectedRef.current = target;
    sessionRef.current = session;
    const remote = async (method: string, args: Dict, device = target) =>
      (await control('remote', { device_id: device, method, args })).value;
    const load = async (device = target, more = false) => {
      const sequence = ++generation.current;
      setLoading(true);
      try {
        const [listing, projects, models] = await Promise.allSettled([
          remote('list', more && cursor ? { cursor } : {}, device),
          ...(more ? [] : [remote('workspaces', {}, device), remote('models', {}, device)]),
        ]);
        if (!mounted.current || sequence !== generation.current || device !== selectedRef.current)
          return;
        if (!more) {
          if (projects.status === 'fulfilled') setWorkspaces(projects.value.items);
          if (models.status === 'fulfilled') setCatalog(models.value);
          setOptionsError(
            [projects, models].some((r) => r.status === 'rejected')
              ? '项目或模型读取失败，请刷新重试，并确认两端设备插件与 DogO 服务均已更新。'
              : '',
          );
        }
        if (listing.status === 'rejected') throw listing.reason;
        const result = listing.value;
        setSessions((old: Dict[]) =>
          more
            ? [
                ...old.filter((s) => !result.items.some((n: Dict) => n.sessionId === s.sessionId)),
                ...result.items,
              ]
            : result.items,
        );
        setCursor(result.nextCursor || result.cursor || '');
      } finally {
        if (mounted.current && sequence === generation.current) setLoading(false);
      }
    };
    const chooseDevice = (id: string) => {
      if (id === target) return;
      generation.current++;
      selectedRef.current = id;
      setTarget(id);
      setSessions([]);
      setSession('');
      setCursor('');
      setSnapshot(null);
      setSnapshotError('');
      setWorkspaces([]);
      setCatalog(null);
      setOptionsError('');
      setProjectFilter('');
      setCreateOpen(false);
      setDetail(false);
      setCreating(!!readLocal(key('create', id)));
      setUnknown(false);
      setMessage('');
      try {
        writeLocal(key('device'), id);
      } catch (e) {
        setError((e as Error).message);
      }
      const previous = readLocal(key('session', id));
      if (previous) restoreSession(previous, id);
    };
    React.useEffect(() => {
      if (!target && devices.length)
        chooseDevice(
          (
            devices.find((d: Dict) => d.id === readLocal(key('device'))) ||
            devices.find((d: Dict) => d.kind === 'desktop' && d.online && d.active) ||
            devices.find((d: Dict) => d.id === status.deviceId) ||
            devices[0]
          ).id,
        );
    }, [devices]);
    React.useEffect(() => {
      if (!target || !online) return;
      void load(target).catch((e) => {
        if (selectedRef.current === target) setError((e as Error).message);
      });
    }, [target, online]);
    React.useEffect(() => {
      mounted.current = true;
      return () => {
        mounted.current = false;
        generation.current++;
      };
    }, []);
    const restoreSession = (id: string, device = target) => {
      setSession(id);
      setSnapshot(null);
      setSnapshotError('');
      setDetail(true);
      bottom.current = true;
      const pending = readLocal(key('prompt', device + '/' + id));
      setMessage(pending?.text || readLocal(key('message', device + '/' + id), ''));
      setUnknown(!!pending);
    };
    const chooseSession = (id: string) => {
      restoreSession(id);
      try {
        writeLocal(key('session', target), id);
      } catch (e) {
        setError((e as Error).message);
      }
    };
    React.useEffect(() => {
      if (!session || !target || !online) return;
      let active = true,
        polling = false;
      const poll = async () => {
        if (polling || document.hidden) return;
        polling = true;
        const revision = modelRevision.current;
        try {
          const result = await remote('snapshot', { sessionId: session });
          if (active && revision === modelRevision.current) {
            setSnapshot(result);
            setSnapshotError('');
          }
        } catch (e) {
          if (active) setSnapshotError((e as Error).message);
        } finally {
          polling = false;
        }
      };
      void poll();
      const timer = setInterval(poll, 2500);
      return () => {
        active = false;
        clearInterval(timer);
      };
    }, [target, session, online]);
    const history = conversation(snapshot);
    React.useEffect(() => {
      if (scroll.current && bottom.current) scroll.current.scrollTop = scroll.current.scrollHeight;
    }, [snapshot]);
    const create = async () => {
      const storage = key('create', target),
        saved = readLocal(storage);
      // Retain the original project together with the ID when creation is uncertain.
      const request =
        typeof saved === 'string'
          ? { sessionId: saved }
          : saved || {
              sessionId: 'dogo-' + crypto.randomUUID(),
              ...(newProject ? { workspaceId: newProject } : {}),
            };
      writeLocal(storage, request);
      setCreating(true);
      const result = await remote('create', request);
      localStorage.removeItem(storage);
      setCreating(false);
      setCreateOpen(false);
      setProjectFilter(request.workspaceId || '@ungrouped');
      chooseSession(result.sessionId);
      await load();
    };
    const beginCreate = () => {
      if (readLocal(key('create', target))) return void run(create);
      setNewProject(
        workspaces.some((w: Dict) => w.workspaceId === projectFilter) ? projectFilter : '',
      );
      setCreateOpen(true);
    };
    const changeModel = async (selection: Dict) => {
      const device = target,
        id = session;
      modelRevision.current++;
      const result = await remote('selectModel', { sessionId: id, ...selection }, device);
      modelRevision.current++;
      if (!mounted.current || device !== selectedRef.current || id !== sessionRef.current) return;
      setSnapshot(
        (old: Dict | null) =>
          old && {
            ...old,
            projections: {
              ...old.projections,
              values: {
                ...old.projections?.values,
                modelSelection: {
                  ...old.projections?.values?.modelSelection,
                  next: result.selected,
                },
              },
            },
          },
      );
      setCatalog((old: Dict | null) => old && { ...old, default: result.selected });
      notify('模型已更新，下次发送生效');
    };
    const send = async () => {
      if (!message.trim() || !online) return;
      const storage = key('prompt', target + '/' + session);
      const request = readLocal(storage) || {
        sessionId: session,
        requestId: crypto.randomUUID(),
        text: message,
      };
      writeLocal(storage, request);
      setUnknown(true);
      const result = await remote('prompt', request);
      if (!result.accepted) throw Error('设备尚未确认接收，请重试原消息。');
      localStorage.removeItem(storage);
      localStorage.removeItem(key('message', target + '/' + session));
      setUnknown(false);
      setMessage('');
      bottom.current = true;
      notify('消息已被执行电脑接收');
    };
    const title = (s: Dict) => s.projections?.values?.title || s.title || '新会话';
    const sessionTitle = sessions.find((s: Dict) => s.sessionId === session);
    const projectFor = (id: string) => workspaces.find((w: Dict) => w.sessionIds.includes(id));
    const sessionProject = projectFor(session);
    const visibleSessions = sessions.filter((s: Dict) => {
      const project = projectFor(s.sessionId);
      return (
        !projectFilter ||
        (projectFilter === '@ungrouped' ? !project : project?.workspaceId === projectFilter)
      );
    });
    const currentModel = snapshot?.projections?.values?.modelSelection?.next || catalog?.default;
    const modelKey = (m: Dict) => JSON.stringify([m.provider, m.model]);
    const modelGroups = catalog?.groups || [];
    const modelInfo = modelGroups
      .find((g: Dict) => g.id === currentModel?.provider)
      ?.models.find((m: Dict) => m.id === currentModel?.model);
    const reasoning = modelInfo?.reasoning;
    const statusText = (d: Dict) =>
      !d.active
        ? '已禁用'
        : isOnline(d)
          ? '在线'
          : d.id === status.deviceId && !status.consumer?.enabled
            ? '仅作为访问方'
            : d.id === status.deviceId
              ? status.consumer?.error
                ? '连接异常'
                : '正在连接'
              : '离线';
    return h(
      'div',
      { className: 'dg-split dg-device-layout' },
      h(
        'aside',
        { className: 'dg-rail dg-device-rail', 'aria-label': '设备列表' },
        h(
          'div',
          { className: 'dg-rail-tools' },
          h(
            'div',
            { className: 'dg-row dg-row-between' },
            h('span', { className: 'dg-label' }, '我的设备'),
            h(Button, {
              icon: 'refresh',
              'aria-label': '刷新设备',
              disabled: busy,
              onClick: () => void run(refresh),
            }),
          ),
        ),
        h(
          'div',
          { className: 'dg-list' },
          ...devices.map((d: Dict) =>
            h(
              'button',
              {
                key: d.id,
                className: 'dg-device-row',
                'aria-current': target === d.id,
                disabled: busy,
                onClick: () => chooseDevice(d.id),
              },
              h(
                'div',
                { className: 'dg-device-icon' },
                h(Icon, { name: d.kind === 'desktop' ? 'monitor' : 'phone', size: 21 }),
              ),
              h(
                'div',
                { className: 'dg-grow' },
                h('div', { className: 'dg-device-name' }, d.name),
                h(
                  Badge,
                  { tone: d.online && d.active ? 'good' : 'muted' },
                  statusText(d),
                  d.id === status.deviceId && ' · 本机',
                ),
              ),
            ),
          ),
        ),
        h(
          'div',
          { className: 'dg-list-foot' },
          h(
            'div',
            { className: 'dg-row' },
            h(Icon, { name: 'cloud', size: 14 }),
            '通过你的 DogO 服务连接',
          ),
          h('div', { style: { marginTop: 4 } }, '新设备登录同一账户后出现在这里。'),
        ),
      ),
      h(
        'section',
        { className: 'dg-editor', 'aria-label': '远程设备工作区' },
        !selected
          ? h(
              Empty,
              { title: '选择一台电脑', icon: 'devices' },
              '连接后可以查看会话，接着说，也可以开始一段新的对话。',
            )
          : h(
              React.Fragment,
              null,
              h(
                'header',
                { className: 'dg-device-summary' },
                h(
                  'div',
                  { className: 'dg-row' },
                  h(Icon, { name: selected.kind === 'desktop' ? 'monitor' : 'phone', size: 20 }),
                  h(
                    'div',
                    null,
                    h('h2', null, selected.name),
                    h(
                      'p',
                      null,
                      selected.id === status.deviceId
                        ? '当前电脑 · 会话在本机执行与保存'
                        : '会话在这台设备上执行与保存',
                    ),
                  ),
                ),
                h(
                  'div',
                  { className: 'dg-row' },
                  h(Badge, { tone: online ? 'good' : 'muted' }, statusText(selected)),
                  selected.id !== status.deviceId &&
                    selected.active &&
                    h(
                      Button,
                      {
                        variant: 'danger',
                        disabled: busy,
                        onClick: () =>
                          confirmAction(
                            '禁用「' + selected.name + '」？',
                            '这台设备会断开 DogO，需要重新登录后才能再次连接。',
                            async () => {
                              await control('revoke', { id: selected.id });
                              await refresh();
                              notify('设备已禁用');
                            },
                            '禁用设备',
                          ),
                      },
                      '禁用',
                    ),
                ),
              ),
              optionsError && h('div', { className: 'dg-notice', role: 'alert' }, optionsError),
              !online && !session
                ? h(
                    Empty,
                    {
                      icon: selected.kind === 'desktop' ? 'monitor' : 'phone',
                      title: !selected.active
                        ? '这台设备已禁用'
                        : selected.kind !== 'desktop'
                          ? '手机负责记录与查看'
                          : selected.id === status.deviceId && !status.consumer?.enabled
                            ? '开启后，让其他设备连接这里'
                            : '电脑暂时离线',
                      action:
                        selected.id === status.deviceId
                          ? h(
                              Button,
                              { variant: 'primary', icon: 'settings', onClick: openSettings },
                              '设置本机访问',
                            )
                          : h(
                              Button,
                              {
                                icon: 'refresh',
                                variant: 'secondary',
                                disabled: busy,
                                onClick: () => void run(refresh),
                              },
                              '刷新连接状态',
                            ),
                    },
                    selected.kind !== 'desktop'
                      ? '手机不执行 Agent。请从左侧选择一台在线电脑继续会话。'
                      : selected.id === status.deviceId
                        ? '设置默认执行目录并开启本机访问。仅操作其他电脑时不需要开启。'
                        : '在这台电脑上打开 DSH 并启用 DogO 设备。也可以先通过备忘录留下指令，等待它上线。',
                  )
                : h(
                    'div',
                    { className: 'dg-split dg-device-conversation', 'data-detail': detail },
                    h(
                      'aside',
                      { className: 'dg-sessions', 'aria-label': '远程会话列表' },
                      h(
                        'div',
                        { className: 'dg-section-title' },
                        h('span', null, '会话'),
                        h(Button, {
                          icon: 'refresh',
                          'aria-label': '刷新会话',
                          disabled: busy || !online || loading,
                          onClick: () => void run(() => load()),
                        }),
                      ),
                      h(
                        'div',
                        { style: { padding: '0 12px 8px' } },
                        h(
                          Field,
                          { label: '项目', hint: '来自执行电脑的 DSH 工作区' },
                          h(
                            'select',
                            {
                              'aria-label': '筛选远端项目',
                              value: projectFilter,
                              disabled: busy || loading,
                              onChange: (e: any) => setProjectFilter(e.target.value),
                            },
                            h('option', { value: '' }, '全部项目'),
                            h('option', { value: '@ungrouped' }, '未分组'),
                            ...workspaces.map((w: Dict) =>
                              h('option', { key: w.workspaceId, value: w.workspaceId }, w.title),
                            ),
                          ),
                        ),
                        h(
                          Button,
                          {
                            icon: 'plus',
                            variant: 'secondary',
                            className: 'dg-wide',
                            disabled: busy || !online || loading,
                            style: { marginTop: 12 },
                            onClick: beginCreate,
                          },
                          creating ? '重试创建会话' : '新建会话',
                        ),
                      ),
                      creating &&
                        h(
                          'p',
                          { className: 'dg-small dg-muted', style: { padding: '0 16px 12px' } },
                          '创建结果待确认，重试会继续核对同一会话。',
                        ),
                      h(
                        'div',
                        { className: 'dg-list' },
                        loading && !sessions.length
                          ? h('div', { className: 'dg-skeleton' })
                          : !visibleSessions.length
                            ? h(
                                Empty,
                                { icon: 'chat', title: '这个项目还没有会话' },
                                '从上方新建一段对话。',
                              )
                            : visibleSessions.map((s: Dict) =>
                                h(
                                  'button',
                                  {
                                    key: s.sessionId,
                                    className: 'dg-session-row',
                                    'aria-current': session === s.sessionId,
                                    disabled: busy,
                                    onClick: () => chooseSession(s.sessionId),
                                  },
                                  h('strong', null, title(s)),
                                  h('small', null, projectFor(s.sessionId)?.title || '未分组'),
                                  h(
                                    'small',
                                    null,
                                    dateLabel(s.updatedAt || s.createdAt) ||
                                      '保存在 ' + selected.name,
                                  ),
                                ),
                              ),
                        cursor &&
                          h(
                            Button,
                            {
                              className: 'dg-wide',
                              disabled: busy || !online,
                              onClick: () => void run(() => load(target, true)),
                            },
                            '加载更多',
                          ),
                      ),
                    ),
                    h(
                      'section',
                      { className: 'dg-chat', 'aria-label': '远程会话' },
                      !session
                        ? h(
                            Empty,
                            {
                              icon: 'chat',
                              title: '接着上次的思路',
                              action: h(
                                Button,
                                {
                                  variant: 'primary',
                                  icon: 'plus',
                                  disabled: busy || !online || loading,
                                  onClick: beginCreate,
                                },
                                creating ? '重试创建会话' : '开始新会话',
                              ),
                            },
                            '选择左侧会话继续讨论。发送后关闭此页面，电脑也会继续处理。',
                          )
                        : h(
                            React.Fragment,
                            null,
                            h(
                              'header',
                              { className: 'dg-chat-head' },
                              h(Button, {
                                icon: 'back',
                                className: 'dg-back',
                                'aria-label': '返回会话列表',
                                onClick: () => setDetail(false),
                              }),
                              h(
                                'div',
                                { className: 'dg-grow' },
                                h('h3', null, sessionTitle ? title(sessionTitle) : '新会话'),
                                h(
                                  'p',
                                  {
                                    className: 'dg-session-project',
                                    title: sessionProject?.path || snapshot?.header?.cwd,
                                  },
                                  (sessionProject?.title || '未分组') +
                                    (sessionProject?.path || snapshot?.header?.cwd
                                      ? ' · ' + (sessionProject?.path || snapshot?.header?.cwd)
                                      : ''),
                                ),
                              ),
                              h(
                                Badge,
                                {
                                  tone:
                                    history.state === '执行出错'
                                      ? 'danger'
                                      : online && !snapshotError
                                        ? 'good'
                                        : 'warning',
                                },
                                !online
                                  ? '连接已断开'
                                  : snapshotError
                                    ? '更新中断'
                                    : snapshot
                                      ? history.state
                                      : '读取中',
                              ),
                            ),
                            snapshotError &&
                              h(
                                'div',
                                { className: 'dg-notice', role: 'alert' },
                                h('span', null, '暂时无法更新会话，将自动重试。' + snapshotError),
                              ),
                            h(
                              'div',
                              {
                                className: 'dg-chat-history',
                                ref: scroll,
                                onScroll: () => {
                                  const el = scroll.current;
                                  bottom.current =
                                    el.scrollHeight - el.scrollTop - el.clientHeight < 90;
                                },
                              },
                              snapshot?.hasMore &&
                                h(
                                  'p',
                                  { className: 'dg-chat-note', style: { marginBottom: 22 } },
                                  '这里显示最近的对话，完整历史保留在执行电脑。',
                                ),
                              !snapshot
                                ? h(
                                    Empty,
                                    { icon: 'chat', title: online ? '正在读取会话' : '设备已离线' },
                                    online
                                      ? '连接执行电脑，获取最近记录。'
                                      : '电脑重新上线后，这里会自动读取最新对话。',
                                  )
                                : !history.items.length
                                  ? h(
                                      Empty,
                                      { icon: 'chat', title: '聊聊你想做的事' },
                                      '这段对话由 ' + selected.name + ' 上的 DSH 处理。',
                                    )
                                  : history.items.map((item) =>
                                      item.role === 'status'
                                        ? h(
                                            'div',
                                            { key: item.id, className: 'dg-notice', role: 'alert' },
                                            h('span', null, item.text),
                                          )
                                        : item.role === 'tool'
                                          ? h(
                                              'details',
                                              { key: item.id, className: 'dg-tool' },
                                              h('summary', null, '工具调用 · ' + item.name),
                                              h('pre', null, item.text),
                                            )
                                          : h(
                                              'article',
                                              {
                                                key: item.id,
                                                className: 'dg-message dg-message-' + item.role,
                                              },
                                              h(
                                                'div',
                                                { className: 'dg-avatar' },
                                                item.role === 'user'
                                                  ? '我'
                                                  : h(Icon, { name: 'chat', size: 15 }),
                                              ),
                                              h(
                                                'div',
                                                { className: 'dg-message-body' },
                                                h(
                                                  'div',
                                                  { className: 'dg-message-label' },
                                                  item.role === 'user'
                                                    ? '你'
                                                    : 'DSH · ' + selected.name,
                                                ),
                                                item.role === 'user'
                                                  ? h(
                                                      'div',
                                                      { className: 'dg-message-text' },
                                                      item.text,
                                                    )
                                                  : h(Markdown, { text: item.text }),
                                              ),
                                            ),
                                    ),
                            ),
                            h(
                              'footer',
                              { className: 'dg-chat-compose' },
                              h(
                                'div',
                                { className: 'dg-model-controls' },
                                h(
                                  Field,
                                  { label: '执行模型' },
                                  h(
                                    'select',
                                    {
                                      'aria-label': '执行模型',
                                      title: '切换会同步执行电脑的默认模型，下次发送生效。',
                                      value: currentModel ? modelKey(currentModel) : '',
                                      disabled: busy || unknown || !online || !snapshot || !catalog,
                                      onChange: (e: any) => {
                                        const [provider, model] = JSON.parse(e.target.value);
                                        void run(() => changeModel({ provider, model }));
                                      },
                                    },
                                    !currentModel &&
                                      h(
                                        'option',
                                        { value: '' },
                                        catalog ? '暂无可用模型' : '正在读取远端模型',
                                      ),
                                    currentModel &&
                                      !modelInfo &&
                                      h(
                                        'option',
                                        { value: modelKey(currentModel), disabled: true },
                                        '当前不可用：' +
                                          currentModel.provider +
                                          ' / ' +
                                          currentModel.model,
                                      ),
                                    ...modelGroups.map((g: Dict) =>
                                      h(
                                        'optgroup',
                                        { key: g.id, label: g.name },
                                        ...g.models.map((m: Dict) =>
                                          h(
                                            'option',
                                            {
                                              key: m.id,
                                              value: modelKey({ provider: g.id, model: m.id }),
                                            },
                                            m.name,
                                          ),
                                        ),
                                      ),
                                    ),
                                  ),
                                ),
                                reasoning?.efforts?.length > 0 &&
                                  h(
                                    Field,
                                    { label: '思考强度' },
                                    h(
                                      'select',
                                      {
                                        'aria-label': '思考强度',
                                        value:
                                          currentModel.reasoningEffort ||
                                          reasoning.defaultEffort ||
                                          '',
                                        disabled: busy || unknown || !online || !snapshot,
                                        onChange: (e: any) =>
                                          void run(() =>
                                            changeModel({
                                              provider: currentModel.provider,
                                              model: currentModel.model,
                                              ...(e.target.value
                                                ? { reasoningEffort: e.target.value }
                                                : {}),
                                            }),
                                          ),
                                      },
                                      !reasoning.defaultEffort &&
                                        h('option', { value: '' }, '模型默认'),
                                      ...reasoning.efforts.map((e: Dict) =>
                                        h('option', { key: e.id, value: e.id }, e.name),
                                      ),
                                    ),
                                  ),
                                h(Button, {
                                  icon: 'refresh',
                                  'aria-label': '刷新远端模型与项目',
                                  disabled: busy || !online || loading,
                                  onClick: () => void run(() => load()),
                                }),
                              ),
                              catalog?.failures?.length > 0 &&
                                h(
                                  'p',
                                  { className: 'dg-small dg-muted', role: 'status' },
                                  '部分模型来源读取失败：' +
                                    catalog.failures.map((f: Dict) => f.name).join('、') +
                                    '。可刷新重试。',
                                ),
                              catalog &&
                                !modelGroups.length &&
                                h(
                                  'p',
                                  { className: 'dg-small dg-muted', role: 'status' },
                                  '请先在执行电脑的 DSH 中配置可用模型。',
                                ),
                              unknown &&
                                h(
                                  'p',
                                  {
                                    className: 'dg-small',
                                    style: { color: 'var(--dg-warning)', marginBottom: 8 },
                                  },
                                  '接收结果待确认。重试使用原消息，不会另建一次请求。',
                                ),
                              h(
                                'div',
                                { className: 'dg-composer-box' },
                                h('textarea', {
                                  'aria-label': '发送给远程会话',
                                  placeholder: online
                                    ? '继续聊，或者告诉电脑下一步做什么…'
                                    : '设备离线，连接恢复后可以继续发送',
                                  disabled: busy || unknown || !online,
                                  value: message,
                                  maxLength: 256000,
                                  onChange: (e: any) => {
                                    setMessage(e.target.value);
                                    try {
                                      writeLocal(
                                        key('message', target + '/' + session),
                                        e.target.value,
                                      );
                                    } catch (err) {
                                      setError((err as Error).message);
                                    }
                                  },
                                  onKeyDown: (e: any) => {
                                    if (
                                      (e.metaKey || e.ctrlKey) &&
                                      e.key === 'Enter' &&
                                      !e.nativeEvent.isComposing
                                    ) {
                                      e.preventDefault();
                                      if (!busy) void run(send);
                                    }
                                  },
                                }),
                                h(
                                  'div',
                                  { className: 'dg-composer-actions' },
                                  h('small', null, '⌘ / Ctrl + Enter 发送'),
                                  h(
                                    'div',
                                    { className: 'dg-row' },
                                    h(
                                      Button,
                                      {
                                        icon: 'stop',
                                        disabled: busy || !online,
                                        onClick: () =>
                                          void run(async () => {
                                            await remote('cancel', { sessionId: session });
                                            notify('停止请求已发送');
                                          }),
                                      },
                                      '停止',
                                    ),
                                    h(
                                      Button,
                                      {
                                        icon: 'arrow',
                                        variant: 'primary',
                                        disabled: busy || !online || !message.trim(),
                                        onClick: () => void run(send),
                                      },
                                      unknown ? '重试原消息' : '发送',
                                    ),
                                  ),
                                ),
                              ),
                              h(
                                'p',
                                { className: 'dg-chat-note' },
                                '离开页面不会停止执行 · 审批和复杂工具交互请回到执行电脑',
                              ),
                            ),
                          ),
                    ),
                  ),
            ),
      ),
      createOpen &&
        h(
          Dialog,
          { title: '新建远端会话', close: () => !busy && setCreateOpen(false) },
          h(
            'div',
            { className: 'dg-settings-section' },
            h('p', null, '会话将在「' + selected.name + '」创建，模型可以在发送前选择。'),
            h(
              Field,
              { label: '所属项目', hint: '使用执行电脑已有的 DSH 工作区及目录。' },
              h(
                'select',
                {
                  'aria-label': '新会话所属项目',
                  value: newProject,
                  disabled: busy || creating,
                  onChange: (e: any) => setNewProject(e.target.value),
                },
                h('option', { value: '' }, '未分组 · 默认执行目录'),
                ...workspaces.map((w: Dict) =>
                  h('option', { key: w.workspaceId, value: w.workspaceId }, w.title),
                ),
              ),
            ),
            newProject &&
              h(
                'p',
                { className: 'dg-project-path' },
                workspaces.find((w: Dict) => w.workspaceId === newProject)?.path,
              ),
            creating && h('p', { role: 'status' }, '创建结果待确认，重试保留原项目和会话编号。'),
            h(
              Button,
              { variant: 'primary', disabled: busy || !online, onClick: () => void run(create) },
              creating ? '重试创建' : '创建会话',
            ),
          ),
        ),
    );
  };
}
