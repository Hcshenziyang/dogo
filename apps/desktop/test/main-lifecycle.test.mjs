import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { registerHooks } from 'node:module';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'dogo-main-lifecycle-'));
  await mkdir(path.join(directory, 'local'));
  await writeFile(path.join(directory, 'local/relay-credential.enc'), 'synthetic credential');
  const names = ['DOGO_USER_DATA_DIR', 'DOGO_DATA_DIR', 'DOGO_NODE'];
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  const resourcesPath = process.resourcesPath;
  process.resourcesPath = directory;
  process.env.DOGO_USER_DATA_DIR = directory;
  process.env.DOGO_DATA_DIR = path.join(directory, 'local');
  process.env.DOGO_NODE = process.execPath;
  const f = { errors: [], loads: 0, visible: true, disposed: false, handlers: new Map(), accountOperations: [] };
  let restore, restoring;
  const restored = new Promise(resolve => { restore = resolve; });
  const restoreStarted = new Promise(resolve => { restoring = resolve; });
  f.restore = restore;
  const contents = new EventEmitter();
  contents.setWindowOpenHandler = () => {};
  contents.send = () => {};
  class BrowserWindow extends EventEmitter {
    constructor() { super(); f.window = this; }
    isDestroyed() { return !!this.destroyed; }
    live() { if (this.destroyed) throw new TypeError('Object has been destroyed'); }
    get webContents() { this.live(); return contents; }
    show() { this.live(); f.visible = true; }
    focus() { this.live(); }
    hide() { this.live(); f.visible = false; }
    isFocused() { this.live(); return f.visible; }
    async loadFile() { this.live(); f.loads++; }
    close() {
      let prevented = false;
      this.emit('close', { preventDefault() { prevented = true; } });
      if (!prevented) this.destroy();
    }
    destroy() { this.destroyed = true; this.emit('closed'); }
  }
  const app = new EventEmitter();
  Object.assign(app, {
    setName() {}, setPath() {}, requestSingleInstanceLock: () => true,
    getPath: () => directory,
    whenReady: () => ({ then(callback) { f.startup = Promise.resolve().then(callback); return f.startup; } }),
    quit() {
      let prevented = false;
      app.emit('before-quit', { preventDefault() { prevented = true; } });
      if (!prevented) f.window?.close();
    },
    exit() {},
  });
  class DesktopHost {
    constructor(_directory, callbacks) { f.host = this; Object.assign(this, callbacks); }
    async start() {}
    async request(method) {
      if (method === 'connectRelay') { restoring(); return restored; }
      if (method === 'snapshot') return { tasks: [], hub: { items: [] } };
      if (method === 'executionStatus') return { active: 0 };
    }
    async close() {}
  }
  class DshWorkspace {
    trusted() { return false; }
    dispose() { f.disposed = true; }
    backendChanged() {}
  }
  class Tray extends EventEmitter {
    setToolTip() {} setContextMenu() {} destroy() { this.destroyed = true; }
    isDestroyed() { return !!this.destroyed; }
  }
  const electron = { app, BrowserWindow, Tray, WebContentsView: class {},
    ipcMain: { handle() {} },
    dialog: { showErrorBox(_title, message) { f.errors.push(message); } },
    Menu: { buildFromTemplate: value => value, setApplicationMenu() {} },
    nativeImage: { createFromBitmap: () => ({ setTemplateImage() {} }) },
    Notification: { isSupported: () => false }, clipboard: {}, shell: {}, systemPreferences: {},
    session: { defaultSession: { setPermissionRequestHandler() {}, setPermissionCheckHandler() {} } },
    safeStorage: { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'fixture', decryptString: () => '{}' },
  };
  const key = 'dogoMainFixture' + randomUUID().replaceAll('-', '');
  globalThis[key] = { electron, DesktopHost, DshWorkspace,
    DesktopAccount: class { async execute(input) { f.accountOperations.push(input); return { ok: true }; } },
    pairingSchema: { parse: value => value } };
  const main = process.env.DOGO_MAIN_LIFECYCLE_TARGET
    ? pathToFileURL(process.env.DOGO_MAIN_LIFECYCLE_TARGET) : new URL('../src/main.mjs', import.meta.url);
  contents.mainFrame = { url: new URL('../../web/dist/index.html', main).href };
  electron.ipcMain.handle = (name, handler) => f.handlers.set(name, handler);
  main.search = '?fixture=' + key;
  const exports = {
    electron: 'export const { app, BrowserWindow, WebContentsView, ipcMain, dialog, Menu, Tray, nativeImage, Notification, clipboard, session, safeStorage, shell, systemPreferences } = fixture.electron;',
    './host/client.mjs': 'export const { DesktopHost } = fixture;',
    './dsh-workspace.mjs': 'export const { DshWorkspace } = fixture; export const workspaceVisibility = value => value.visible;',
    './account.mjs': 'export const { DesktopAccount } = fixture;',
    '@dogo/contracts/pairing': 'export const { pairingSchema } = fixture;',
  };
  const hooks = registerHooks({
    resolve(specifier, context, next) {
      if (context.parentURL === main.href && specifier in exports)
        return { url: 'dogo-fixture:' + key + '/' + specifier, shortCircuit: true };
      return next(specifier, context);
    },
    load(url, context, next) {
      const prefix = 'dogo-fixture:' + key + '/';
      if (url.startsWith(prefix)) return { format: 'module', shortCircuit: true,
        source: `const fixture = globalThis[${JSON.stringify(key)}];\n` + exports[url.slice(prefix.length)] };
      return next(url, context);
    },
  });
  t.after(async () => {
    restore(); await f.startup?.catch(() => {});
    hooks.deregister(); delete globalThis[key];
    if (resourcesPath === undefined) delete process.resourcesPath;
    else process.resourcesPath = resourcesPath;
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    await rm(directory, { recursive: true, force: true });
  });
  await import(main.href);
  await Promise.race([restoreStarted, f.startup.then(() => {
    throw new Error('Startup ended before account restoration: ' + f.errors.join(', '));
  })]);
  return { ...f, state: f, app, contents };
}

test('closing while saved-account restoration is pending hides the window and startup completes', async t => {
  const f = await fixture(t);
  assert.equal(f.state.loads, 1, 'the local page must load without waiting for the relay');
  f.window.close();
  assert.equal(f.window.isDestroyed(), false);
  assert.equal(f.state.visible, false);
  f.restore(); await f.startup;
  assert.equal(f.state.loads, 1);
  assert.deepEqual(f.state.errors, []);
  f.app.emit('second-instance'); assert.equal(f.state.visible, true);
  f.window.close(); f.app.emit('activate'); assert.equal(f.state.visible, true);
});

test('activation and snapshot callbacks tolerate an already destroyed window', async t => {
  const f = await fixture(t);
  f.restore(); await f.startup;
  f.window.destroy();
  assert.equal(f.state.disposed, true);
  assert.doesNotThrow(() => f.app.emit('activate'));
  assert.doesNotThrow(() => f.app.emit('second-instance'));
  const snapshot = { tasks: [], hub: { syncedAt: 'fixture', items: [] } };
  assert.doesNotThrow(() => { f.host.onSnapshot(snapshot); f.host.onSnapshot(snapshot); });
});

test('quitting during saved-account restoration does not reuse a destroyed window afterwards', async t => {
  const f = await fixture(t);
  assert.equal(f.state.loads, 1);
  f.app.quit();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.window.isDestroyed(), true);
  assert.equal(f.state.disposed, true);
  f.restore(); await f.startup;
  assert.equal(f.state.loads, 1);
  assert.deepEqual(f.state.errors, []);
  assert.doesNotThrow(() => f.app.emit('activate'));
});

test('account operations wait for restoration while the local page stays available', async t => {
  const f = await fixture(t);
  assert.equal(f.state.loads, 1);
  const pending = f.handlers.get('dogo:account')({ sender: f.contents, senderFrame: f.contents.mainFrame }, { op: 'logout' });
  pending.catch(() => {});
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.state.accountOperations, []);
  f.restore();
  assert.deepEqual(await pending, { ok: true });
  assert.deepEqual(f.state.accountOperations, [{ op: 'logout' }]);
});
