import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { DshWorkspace, localWorkspaceUrl, sameWorkspace, externalWorkspaceUrl, workspaceVisibility, WORKSPACE_TOP } from '../src/dsh-workspace.mjs';

function fixture(overrides = {}) {
  const window = new EventEmitter();
  const children = new Set();
  window.contentView = { addChildView: view => children.add(view), removeChildView: view => children.delete(view) };
  window.getContentSize = () => [1200, 800]; window.isDestroyed = () => false;
  const views = [], events = [], opened = [];
  let generation = 'generation-a', url = 'http://127.0.0.1:12345/?token=PRIVATE_BOOTSTRAP', loads = 0;
  const createView = options => {
    const contents = new EventEmitter();
    contents.session = {
      flushStorageData: () => { contents.flushed = true; },
      setPermissionCheckHandler: handler => { contents.checkPermission = handler; },
      setPermissionRequestHandler: handler => { contents.requestPermission = handler; },
    };
    contents.setWindowOpenHandler = fn => { contents.openWindow = fn; };
    contents.loadURL = async value => { loads++; contents.url = value; await overrides.load?.(); };
    contents.getURL = () => contents.url;
    contents.isDestroyed = () => !!contents.closed;
    contents.close = () => { contents.closed = true; };
    const view = { webContents: contents, options, setVisible(value) { this.visible = value; }, setBounds(value) { this.bounds = value; } };
    views.push(view); return view;
  };
  const host = new DshWorkspace({ window, createView, getUrl: async () => url, getBackend: () => ({ generation }),
    changed: value => events.push(value), confirmExternal: async () => true, openExternal: async value => opened.push(value), ...overrides });
  return { host, window, views, events, opened, children, loads: () => loads,
    restart() { generation = 'generation-b'; url = 'http://127.0.0.1:23456/?token=NEXT_PRIVATE'; host.backendChanged({ state: 'ready', generation }); } };
}

test('bootstrap, navigation and visibility accept only the narrow contract', () => {
  assert.equal(localWorkspaceUrl('http://127.0.0.1:3210/?token=secret').origin, 'http://127.0.0.1:3210');
  for (const value of ['file:///etc/passwd', 'https://example.com', 'http://localhost:3210', 'http://127.0.0.1', 'http://user:pass@127.0.0.1:3210', 'javascript:alert(1)'])
    assert.throws(() => localWorkspaceUrl(value));
  assert(sameWorkspace('http://127.0.0.1:3210/new-upstream-route#tab', 'http://127.0.0.1:3210'));
  assert(!sameWorkspace('http://127.0.0.1:3211/', 'http://127.0.0.1:3210'));
  assert(!sameWorkspace('http://127.0.0.1.example.com:3210/', 'http://127.0.0.1:3210'));
  assert.equal(externalWorkspaceUrl('https://example.com/oauth?state=x').origin, 'https://example.com');
  for (const value of ['file:///tmp/x', 'javascript:alert(1)', 'http://example.com', 'https://user:password@example.com']) assert.equal(externalWorkspaceUrl(value), null);
  assert.equal(workspaceVisibility({ visible: false }), false);
  for (const value of [null, true, [], { visible: 'yes' }, { visible: true, url: 'file:///tmp' }]) assert.throws(() => workspaceVisibility(value));
});

test('isolated view retains the same document across tabs and keeps bootstrap out of shell state', async () => {
  const f = fixture(); await f.host.show(true);
  const view = f.views[0], preferences = view.options.webPreferences;
  assert.equal(preferences.nodeIntegration, false); assert.equal(preferences.contextIsolation, true);
  assert.equal(preferences.sandbox, true); assert.equal(preferences.webSecurity, true);
  assert.equal(preferences.preload, undefined); assert.equal(preferences.webviewTag, false);
  assert.equal(preferences.partition, 'persist:dogo-dsh-workspace');
  assert.deepEqual(view.bounds, { x: 0, y: WORKSPACE_TOP, width: 1200, height: 800 - WORKSPACE_TOP });
  await f.host.show(false); assert.equal(view.visible, false); assert.equal(f.children.size, 0);
  await f.host.show(true); assert.equal(view.visible, true); assert.equal(f.loads(), 1); assert.equal(f.children.size, 1);
  assert.equal(f.views.length, 1); assert.doesNotMatch(JSON.stringify(f.events), /PRIVATE_BOOTSTRAP|127\.0\.0\.1/);
  f.window.getContentSize = () => [950, 650]; f.window.emit('resize'); assert.equal(view.bounds.width, 950);
  f.host.dispose(); assert.equal(view.webContents.closed, true); assert.equal(f.children.size, 0);
  assert.equal(view.webContents.flushed, true);
  assert.equal(f.window.listenerCount('resize'), 0);
});

test('switching away during startup never covers the shell after loading finishes', async () => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  const f = fixture({ load: () => gate });
  const first = f.host.show(true); await new Promise(resolve => setImmediate(resolve));
  await f.host.show(false); release(); await first;
  assert.equal(f.host.snapshot().phase, 'ready'); assert.equal(f.views[0].visible, false);
  await f.host.show(true); assert.equal(f.loads(), 1); f.host.dispose();
});

test('view cannot acquire native privileges or navigate to other processes without confirmation', async () => {
  const f = fixture(); await f.host.show(true); const contents = f.views[0].webContents;
  assert.equal(contents.checkPermission(contents, 'clipboard-sanitized-write', 'http://127.0.0.1:12345'), true);
  for (const permission of ['media', 'clipboard-read', 'display-capture', 'fileSystem'])
    assert.equal(contents.checkPermission(contents, permission, 'http://127.0.0.1:12345'), false);
  assert.equal(contents.checkPermission({}, 'clipboard-sanitized-write', 'http://127.0.0.1:12345'), false);
  let prevented = false;
  contents.emit('will-frame-navigate', { url: 'file:///etc/passwd', isMainFrame: true, preventDefault() { prevented = true; } });
  assert.equal(prevented, true); assert.deepEqual(f.opened, []);
  contents.emit('will-redirect', { url: 'https://example.com/?token=PRIVATE_BOOTSTRAP', isMainFrame: true, preventDefault() {} });
  assert.deepEqual(f.opened, []);
  assert.deepEqual(contents.openWindow({ url: 'https://example.com/docs' }), { action: 'deny' });
  await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(f.opened, ['https://example.com/docs']);
  await f.host.show(false); contents.openWindow({ url: 'https://example.com/hidden' });
  assert.equal(f.opened.length, 1); f.host.dispose();
});

test('backend restart reconnects only the view, and renderer crash is recoverable', async () => {
  const f = fixture(); await f.host.show(true);
  f.restart(); await f.host.loading;
  assert.equal(f.loads(), 2); assert.equal(f.views.length, 1);
  assert.equal(f.host.origin, 'http://127.0.0.1:23456');
  f.views[0].webContents.emit('render-process-gone'); assert.equal(f.host.snapshot().phase, 'error');
  assert.equal(f.views[0].visible, false); await f.host.load(true); assert.equal(f.loads(), 3);
  f.host.backendChanged({ state: 'failed' }); assert.equal(f.host.snapshot().phase, 'error'); f.host.dispose();
});

test('failed loading never exposes authenticated URL and close during startup never attaches a late view', async () => {
  const failed = fixture({ getUrl: async () => { throw new Error('http://127.0.0.1:12345/?token=PRIVATE_BOOTSTRAP'); } });
  await failed.host.show(true); assert.equal(failed.host.snapshot().phase, 'error');
  assert.doesNotMatch(JSON.stringify(failed.events), /PRIVATE_BOOTSTRAP|127\.0\.0\.1/); failed.host.dispose();
  let release; const gate = new Promise(resolve => { release = resolve; });
  const closing = fixture({ getUrl: () => gate }); const pending = closing.host.show(true);
  closing.host.dispose(); release('http://127.0.0.1:12345/'); await pending;
  assert.equal(closing.views.length, 0);
});

test('native preload accepts only the current DSH main frame and revokes trust after crash/disposal', async () => {
  const f = fixture({ preload: '/app/dsh-preload.cjs' }); await f.host.show(true);
  const contents = f.views[0].webContents;
  contents.mainFrame = { url: 'http://127.0.0.1:12345/' };
  const event = { sender: contents, senderFrame: contents.mainFrame };
  assert.equal(f.views[0].options.webPreferences.preload, '/app/dsh-preload.cjs');
  assert(f.host.trusted(event));
  assert(!f.host.trusted({ ...event, sender: {} }));
  assert(!f.host.trusted({ ...event, senderFrame: { url: contents.mainFrame.url } }));
  contents.mainFrame.url = 'https://example.com'; assert(!f.host.trusted(event));
  contents.mainFrame.url = 'http://127.0.0.1:12345/'; assert(f.host.trusted(event));
  contents.emit('render-process-gone'); assert(!f.host.trusted(event));
  f.host.dispose(); assert(!f.host.trusted(event));
});
