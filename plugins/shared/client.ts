// Uses DSH's published main-panel and sidebar slots; no DOM patching.
import { createUI } from './ui.js';
import { styles } from './styles.js';
import { readLocal, writeLocal, type Control, type Dict } from './presentation.js';
import { createMemosView } from '../memos/view.js';
import { createDevicesView } from '../devices/view.js';

declare const window: any;
export function registerClient(kind: 'memos' | 'devices', title: string) {
  window.__ModuleLoader__.load({
    id: 'dogo-' + kind + '/client',
    factory: (require: any) => {
      const React = require('react');
      const ui = createUI(React),
        { h, Icon, Button, Badge, Field, Dialog } = ui;
      const Content = kind === 'memos' ? createMemosView(React, ui) : createDevicesView(React, ui);
      function Panel({ control }: { control: Control }) {
        const [status, setStatus] = React.useState(null as Dict | null);
        const [devices, setDevices] = React.useState([] as Dict[]);
        const [busy, setBusy] = React.useState(false),
          [error, setError] = React.useState('');
        const [notice, setNotice] = React.useState(''),
          [settings, setSettings] = React.useState(false);
        const [confirmation, setConfirmation] = React.useState(null as any);
        const [login, setLogin] = React.useState(() => ({
          server: '',
          username: '',
          name: '我的电脑',
          ...readLocal('dogo.login.preferences', {}),
          password: '',
        }));
        const [cwd, setCwd] = React.useState('');
        const mounted = React.useRef(true),
          flight = React.useRef(false),
          refreshSequence = React.useRef(0);
        const run = async (fn: () => Promise<unknown>) => {
          if (flight.current) return;
          flight.current = true;
          setBusy(true);
          setError('');
          setNotice('');
          try {
            await fn();
          } catch (e) {
            if (mounted.current) setError((e as Error).message);
          } finally {
            flight.current = false;
            if (mounted.current) setBusy(false);
          }
        };
        const refresh = async () => {
          const sequence = ++refreshSequence.current;
          const next = await control('status');
          if (!mounted.current || sequence !== refreshSequence.current) return next;
          try {
            if (next.loggedIn) {
              const list = await control('devices');
              if (mounted.current && sequence === refreshSequence.current) setDevices(list);
            } else setDevices([]);
          } finally {
            if (mounted.current && sequence === refreshSequence.current) setStatus(next);
          }
          return next;
        };
        React.useEffect(() => {
          mounted.current = true;
          void run(refresh);
          return () => {
            mounted.current = false;
          };
        }, []);
        React.useEffect(() => {
          if (!status?.loggedIn || (kind !== 'devices' && !settings)) return;
          let active = true,
            polling = false;
          const timer = setInterval(async () => {
            if (polling || flight.current || document.hidden) return;
            polling = true;
            const sequence = ++refreshSequence.current;
            try {
              const next = await control('status');
              const list = next.loggedIn ? await control('devices') : [];
              if (active && !flight.current && sequence === refreshSequence.current) {
                setStatus(next);
                setDevices(list);
              }
            } catch (e) {
              if (active) setError((e as Error).message);
            } finally {
              polling = false;
            }
          }, 5000);
          return () => {
            active = false;
            clearInterval(timer);
          };
        }, [status?.loggedIn, settings]);
        React.useEffect(() => {
          if (!notice) return;
          const timer = setTimeout(() => setNotice(''), 5000);
          return () => clearTimeout(timer);
        }, [notice]);
        const openSettings = () => {
          setCwd(status?.consumer?.cwd || '');
          setSettings(true);
        };
        const configure = (enabled: boolean, directory: string, notice?: string) =>
          void run(async () => {
            ++refreshSequence.current;
            const consumer = await control('configure', { enabled, cwd: directory });
            setStatus((previous: Dict) => ({ ...previous, consumer }));
            setCwd(consumer.cwd);
            setNotice(notice || (enabled ? '本机访问已开启，正在连接服务' : '本机访问已关闭'));
            await refresh();
          });
        const confirmAction = (
          heading: string,
          description: string,
          action: () => Promise<void>,
          label = '确认',
        ) => setConfirmation({ heading, description, action, label });
        const connected = !!status?.consumer?.online;
        const accessState = !status?.consumer?.enabled
          ? '本机仅作为访问方'
          : connected
            ? '本机可被访问'
            : status.consumer.error
              ? '本机连接异常'
              : '本机正在连接';
        const header = h(
          'header',
          { className: 'dg-page-head' },
          h(
            'div',
            { className: 'dg-title' },
            h(
              'div',
              { className: 'dg-title-mark' },
              h(Icon, { name: kind === 'memos' ? 'note' : 'devices', size: 21 }),
            ),
            h(
              'div',
              null,
              h('h1', null, kind === 'memos' ? '备忘录' : '设备与会话'),
              h(
                'p',
                null,
                kind === 'memos'
                  ? '随手记下，在其他设备接着处理。'
                  : '连接你的电脑，继续原来的对话。',
              ),
            ),
          ),
          h(
            'div',
            { className: 'dg-head-actions' },
            status?.loggedIn &&
              h(
                'span',
                { className: 'dg-head-status' },
                h(
                  Badge,
                  { tone: kind === 'devices' && connected ? 'good' : 'muted' },
                  kind === 'memos' ? 'DogO · ' + status.username : accessState,
                ),
              ),
            status?.loggedIn &&
              h(Button, {
                icon: 'settings',
                'aria-label': 'DogO 设置',
                title: '账户与本机设置',
                onClick: openSettings,
              }),
          ),
        );
        const settingsView =
          settings &&
          !confirmation &&
          h(
            Dialog,
            { title: 'DogO 设置', close: () => setSettings(false) },
            error &&
              h('p', { className: 'dg-notice', role: 'alert', style: { marginBottom: 20 } }, error),
            h(
              'section',
              { className: 'dg-settings-section' },
              h('h3', null, '账户与同步服务'),
              h(
                'div',
                { className: 'dg-account' },
                h(
                  'div',
                  { className: 'dg-account-icon' },
                  status.username.slice(0, 1).toUpperCase(),
                ),
                h('div', null, h('strong', null, status.username), h('small', null, status.server)),
              ),
              h('p', null, '两个 DogO 插件共用此账户。备忘录保存到你的服务，会话保留在执行电脑。'),
              h(
                Button,
                {
                  icon: 'logout',
                  variant: 'secondary',
                  disabled: busy,
                  onClick: () =>
                    confirmAction(
                      '退出 DogO？',
                      '本机将断开 DogO，已接收的会话仍由执行电脑继续处理。',
                      async () => {
                        await control('logout');
                        setSettings(false);
                        await refresh();
                      },
                      '退出登录',
                    ),
                },
                '退出登录',
              ),
            ),
            status.consumer &&
              h(
                'section',
                { className: 'dg-settings-section' },
                h(
                  'div',
                  { className: 'dg-row dg-row-between' },
                  h('h3', null, '允许其他设备访问本机'),
                  h('input', {
                    type: 'checkbox',
                    className: 'dg-switch',
                    'aria-label': '允许其他设备访问本机',
                    checked: !!status.consumer.enabled,
                    disabled: busy,
                    onChange: (e: any) =>
                      configure(e.target.checked, e.target.checked ? cwd : status.consumer.cwd),
                  }),
                ),
                h(
                  'p',
                  null,
                  '开关立即生效。开启后，同一账户的其他设备可查看和继续本机会话，也可向本机发送备忘录指令。',
                ),
                h('p', { role: 'status' }, busy ? '正在保存设置…' : accessState),
                h(Field, {
                  label: '默认执行目录',
                  hint: '新会话在此目录执行；已有会话保留原目录。首次默认使用本机用户目录。',
                  placeholder: '/Users/你/工作目录',
                  value: cwd,
                  disabled: busy,
                  onChange: (e: any) => setCwd(e.target.value),
                }),
                h(
                  Button,
                  {
                    variant: 'primary',
                    disabled: busy || cwd.trim() === status.consumer.cwd,
                    onClick: () => configure(!!status.consumer.enabled, cwd, '执行目录已保存'),
                  },
                  busy ? '正在保存…' : '保存执行目录',
                ),
                status.consumer.error && h('p', { role: 'alert' }, status.consumer.error),
              ),
            h('p', { className: 'dg-small dg-muted' }, '仅查看远端电脑时，无需开启本机接单。'),
          );
        const loginView = h(
          'div',
          { className: 'dg-login' },
          h(
            'section',
            { className: 'dg-login-copy' },
            h('div', { className: 'dg-label' }, 'D O G O'),
            h('h2', null, '想法随手记，', h('br'), '换个设备继续。'),
            h('p', null, '把零散的记录带到一起，也把电脑上的对话带到身边。'),
            h(
              'div',
              { className: 'dg-login-feature' },
              h(Icon, { name: 'cloud' }),
              '备忘录在你的设备间共享',
            ),
            h(
              'div',
              { className: 'dg-login-feature' },
              h(Icon, { name: 'chat' }),
              '连接在线电脑，继续已有会话',
            ),
          ),
          h(
            'form',
            {
              className: 'dg-login-card',
              onSubmit: (e: any) => {
                e.preventDefault();
                void run(async () => {
                  try {
                    await control('login', login);
                    writeLocal('dogo.login.preferences', {
                      server: login.server,
                      username: login.username,
                      name: login.name,
                    });
                  } finally {
                    setLogin((old: Dict) => ({ ...old, password: '' }));
                  }
                  await refresh();
                });
              },
            },
            h('h3', null, '连接 DogO'),
            h('p', null, '使用你在服务端创建的账户登录'),
            h(Field, {
              label: 'DogO 服务地址',
              type: 'url',
              placeholder: 'https://你的服务地址',
              required: true,
              autoComplete: 'url',
              value: login.server,
              onChange: (e: any) => setLogin({ ...login, server: e.target.value }),
            }),
            h(Field, {
              label: '账户',
              required: true,
              autoComplete: 'username',
              value: login.username,
              onChange: (e: any) => setLogin({ ...login, username: e.target.value }),
            }),
            h(Field, {
              label: '密码',
              type: 'password',
              required: true,
              autoComplete: 'current-password',
              value: login.password,
              onChange: (e: any) => setLogin({ ...login, password: e.target.value }),
            }),
            h(
              'details',
              null,
              h('summary', null, '本机名称 · ' + login.name),
              h(Field, {
                label: '本机名称',
                required: true,
                value: login.name,
                onChange: (e: any) => setLogin({ ...login, name: e.target.value }),
              }),
            ),
            h(
              Button,
              { type: 'submit', variant: 'primary', className: 'dg-wide', disabled: busy },
              busy ? '正在连接…' : '登录',
            ),
          ),
        );
        return h(
          'div',
          { className: 'dogo', 'data-dogo': kind },
          h('style', null, styles),
          header,
          error &&
            h(
              'div',
              { className: 'dg-notice', role: 'alert' },
              h(Icon, { name: 'info', size: 16 }),
              h('span', null, error),
              !status &&
                h(Button, { disabled: busy, onClick: () => void run(refresh) }, '重新连接'),
              h(Button, {
                icon: 'close',
                'aria-label': '关闭错误提示',
                onClick: () => setError(''),
              }),
            ),
          notice &&
            h(
              'div',
              { className: 'dg-notice dg-success', role: 'status' },
              h(Icon, { name: 'check', size: 16 }),
              h('span', null, notice),
            ),
          !status
            ? h('div', { className: 'dg-empty', role: 'status' }, '正在连接 DogO…')
            : status.loggedIn
              ? h(Content, {
                  key: status.server + '/' + status.username,
                  control,
                  status,
                  devices,
                  refresh,
                  run,
                  busy,
                  setError,
                  notify: setNotice,
                  confirmAction,
                  openSettings,
                })
              : loginView,
          settingsView,
          confirmation &&
            h(
              Dialog,
              {
                title: confirmation.heading,
                close: () => {
                  if (!busy) setConfirmation(null);
                },
              },
              h('p', { className: 'dg-muted' }, confirmation.description),
              error &&
                h('p', { className: 'dg-notice', role: 'alert', style: { marginTop: 16 } }, error),
              h(
                'div',
                { className: 'dg-row', style: { marginTop: 24 } },
                h(
                  Button,
                  { variant: 'secondary', disabled: busy, onClick: () => setConfirmation(null) },
                  '取消',
                ),
                h(
                  Button,
                  {
                    variant: 'primary',
                    disabled: busy,
                    onClick: () =>
                      void run(async () => {
                        await confirmation.action();
                        setConfirmation(null);
                      }),
                  },
                  busy ? '处理中…' : confirmation.label,
                ),
              ),
            ),
        );
      }
      function apply(ctx: any) {
        const control: Control = async (method, payload = {}) => {
          const result = await ctx.connection.rpc.call('/dogo-' + kind, method, payload);
          if (!result.ok) throw Error(result.error?.message || 'DogO 请求失败');
          return result.value;
        };
        ctx.slots.inject('main', () =>
          ctx.slots.register(
            { name: 'main', key: 'dogo-' + kind, inject: () => ({ control }) },
            Panel,
          ),
        );
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            {
              name: 'sidebar.panellist',
              id: 'dogo-' + kind,
              order: kind === 'memos' ? 10 : 11,
              label: () => title,
            },
            ({ size }: any) => h(Icon, { name: kind === 'memos' ? 'note' : 'devices', size }),
          ),
        );
      }
      return { apply, inject: ['connection', 'slots'] };
    },
  });
}
