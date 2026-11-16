// Synthetic data for the opt-in desktop UI regression; no user accounts or models are used.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { createDevicesView } from '../../devices/view.ts';
import { createUI } from '../../shared/ui.ts';
import { styles } from '../../shared/styles.ts';

const h = React.createElement;
const ui = createUI(React);
const Devices = createDevicesView(React, ui);
const fixture = {
  archived: ['archived'],
  invalid: false,
  addEarlierRecord: false,
  sessions: [
    { sessionId: 'active', title: '活动会话' },
    { sessionId: 'archived', title: '已归档会话' },
    { sessionId: 'other', title: '未分组会话' },
  ],
};
window.fixture = fixture;
const longText =
  '**加粗文字**\n\n| 列 A | 列 B |\n| --- | --- |\n| 甲 | 乙 |\n\n' +
  Array.from({ length: 24 }, (_, i) => `第 ${i + 1} 行用于测试长消息折叠。`).join('\n');
const records = [
  {
    event: {
      seq: 1,
      type: 'user/message',
      data: { source: { kind: 'user' }, content: [{ type: 'text', text: longText }] },
    },
  },
  {
    event: {
      seq: 2,
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: '**答复**' }] } },
    },
  },
];
const control = async (name, { method }) => {
  if (name !== 'remote') throw Error('Unexpected request');
  if (method === 'list') return { value: { items: fixture.sessions } };
  if (method === 'workspaces')
    return {
      value: fixture.invalid
        ? { items: [] }
        : {
            items: [
              {
                workspaceId: 'project',
                title: '测试项目',
                path: '/synthetic',
                sessionIds: ['active', 'archived'],
              },
            ],
            archivedSessionIds: fixture.archived,
          },
    };
  if (method === 'models') return { value: { groups: [] } };
  if (method === 'snapshot')
    return {
      value: {
        records: fixture.addEarlierRecord
          ? [{ event: { seq: 0, type: 'turn/start', data: {} } }, ...records]
          : records,
        projections: { values: {} },
      },
    };
  throw Error('Unexpected method: ' + method);
};
const devices = [
  { id: 'mac', name: '测试电脑', kind: 'desktop', active: true, online: true },
  { id: 'phone', name: '测试手机', kind: 'mobile', active: true, online: false },
];
const status = {
  server: 'synthetic',
  username: 'fixture',
  deviceId: 'mac',
  consumer: { enabled: true, online: true },
};
const style = document.createElement('style');
style.textContent = styles + '\nhtml,body,#root{height:100%;margin:0}';
document.head.append(style);
createRoot(document.getElementById('root')).render(
  h(
    'div',
    { className: 'dogo' },
    h(Devices, {
      control,
      status,
      devices,
      refresh: async () => {},
      run: async (fn) => fn(),
      busy: false,
      setError: (error) => {
        throw Error(error);
      },
      notify: () => {},
      confirmAction: () => {},
      openSettings: () => {},
    }),
  ),
);
