// Exercise the real DogO settings panel with synthetic account and device data.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { registerClient } from '../../shared/client.ts';

const fixture = {
  status: {
    loggedIn: true,
    server: 'https://example.test',
    username: 'fixture',
    deviceId: 'local',
    consumer: { enabled: false, online: false, cwd: '/synthetic' },
  },
  devices: [
    { id: 'local', name: '我的电脑', kind: 'desktop', active: true, online: false },
    { id: 'other', name: '我的电脑', kind: 'desktop', active: true, online: false },
  ],
  renameCalls: 0,
};
window.fixture = fixture;
const call = async (_route, method, payload) => {
  if (method === 'status') return { ok: true, value: fixture.status };
  if (method === 'devices') return { ok: true, value: fixture.devices.map((d) => ({ ...d })) };
  if (method === 'rename-device') {
    fixture.renameCalls++;
    if (payload.password !== 'synthetic-password')
      return { ok: false, error: { message: '账户密码不正确，请重试。' } };
    fixture.devices[0].name = payload.name;
    return { ok: true, value: fixture.status };
  }
  return { ok: false, error: { message: 'Unexpected request: ' + method } };
};
const root = createRoot(document.getElementById('root'));
window.__ModuleLoader__ = {
  load({ factory }) {
    const plugin = factory((name) => {
      if (name === 'react') return React;
      throw Error('Unexpected module: ' + name);
    });
    plugin.apply({
      connection: { rpc: { call } },
      slots: {
        inject(_name, callback) {
          callback();
        },
        register(descriptor, Component) {
          if (descriptor.name === 'main')
            root.render(React.createElement(Component, descriptor.inject()));
        },
      },
    });
  },
};
registerClient('DogO 设备');
