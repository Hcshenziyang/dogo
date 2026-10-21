import {
  app,
  BrowserWindow,
  WebContentsView,
  ipcMain,
  dialog,
  Menu,
  Tray,
  nativeImage,
  Notification,
  clipboard,
  session,
  safeStorage,
  shell,
  systemPreferences,
} from "electron";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import { pairingSchema } from '@dogo/contracts/pairing';
import { DesktopHost } from './host/client.mjs';
import { DshWorkspace, workspaceVisibility } from './dsh-workspace.mjs';
import { DesktopAccount } from './account.mjs';

app.setName("DogO");
// Isolated manual acceptance runs must not share the installed app's lock, cache or credentials.
if (process.env.DOGO_USER_DATA_DIR) {
  if (!path.isAbsolute(process.env.DOGO_USER_DATA_DIR)) throw new Error('DOGO_USER_DATA_DIR must be absolute');
  app.setPath('userData', process.env.DOGO_USER_DATA_DIR);
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  let window,
    tray,
    host,
    workspace,
    quitting = false,
    shutdownStarted = false,
    latest;
  const entryFile = fileURLToPath(
    new URL("../../web/dist/index.html", import.meta.url),
  );
  const entryUrl = pathToFileURL(entryFile).href;
  async function rpc(method, params) {
    if (!host) throw new Error('DSH 后端尚未连接');
    return host.request(method, params);
  }
  function show() {
    if (window) {
      window.show();
      window.focus();
    }
  }
  function updateTray() {
    if (!tray) return;
    const status = !latest?.relay?.configured ? '未登录 · 本机可用' : !latest.relay.connected ? '中转离线 · 等待重连' : latest.hub?.policy.autoExecute ? '在线 · 允许接单' : '在线 · 接单暂停';
    tray.setToolTip('DogO · ' + status);
    tray.setContextMenu(Menu.buildFromTemplate([{ label: status, enabled: false }, { label: '打开 DogO', click: show }, { type: 'separator' }, { label: '完全退出，停止接单', click: () => app.quit() }]));
  }
  app.on("second-instance", show);
  app.on("activate", show);
  app.on("window-all-closed", () => {});
  app
    .whenReady()
    .then(async () => {
      const nodeBinary = process.env.DOGO_NODE ?? path.join(process.resourcesPath, 'node/bin/node');
      if (!existsSync(nodeBinary)) throw new Error('缺少 Node 运行时，请通过 pnpm dev:desktop 启动开发版或重新安装完整 DogO.app');
      const directory =
        process.env.DOGO_DATA_DIR ??
        path.join(app.getPath("userData"), "local");
      const credentialFile = path.join(directory, 'relay-credential.enc');
      const encryptionReady = () => safeStorage.isEncryptionAvailable() &&
        !(process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text');
      let currentCredential;
      const saveCredential = pairing => {
        if (!encryptionReady()) throw new Error('系统安全存储不可用，未保存登录');
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        writeFileSync(credentialFile + '.tmp', safeStorage.encryptString(JSON.stringify(pairing)), { mode: 0o600 });
        renameSync(credentialFile + '.tmp', credentialFile); currentCredential = pairing;
      };
      const installationFile = path.join(directory, 'account-installation.json');
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const installationId = existsSync(installationFile) ? JSON.parse(readFileSync(installationFile, 'utf8')).id : randomUUID();
      if (!/^[a-f0-9-]{36}$/.test(installationId)) throw new Error('账号设备标识损坏，原文件保留');
      if (!existsSync(installationFile)) writeFileSync(installationFile, JSON.stringify({ id: installationId }), { mode: 0o600, flag: 'wx' });
      const account = new DesktopAccount({ platform: process.platform === 'darwin' ? 'mac' : 'win', installationId,
        read: () => currentCredential, save: saveCredential,
        readOrigin: () => JSON.parse(readFileSync(installationFile, 'utf8')).url || '',
        saveOrigin: url => {
          writeFileSync(installationFile + '.tmp', JSON.stringify({ id: installationId, url }), { mode: 0o600 });
          renameSync(installationFile + '.tmp', installationFile);
        },
        clear: () => { rmSync(credentialFile, { force: true }); currentCredential = undefined; },
        connect: pair => rpc('connectRelay', pair), disconnect: () => rpc('disconnectRelay'),
      });
      // Keep model-provider credentials and unrelated environment secrets out of the runtime.
      const env = Object.fromEntries(
        ["HOME", "USERPROFILE", "PATH", "TMPDIR", "TEMP", "SystemRoot", "LANG"]
          .filter((k) => process.env[k])
          .map((k) => [k, process.env[k]]),
      );
      env.PATH = [path.dirname(nodeBinary), '/opt/homebrew/bin', '/usr/local/bin', path.join(app.getPath('home'), '.local/bin'), env.PATH].filter(Boolean).join(path.delimiter);
      if (process.env.SSH_AUTH_SOCK) env.SSH_AUTH_SOCK = process.env.SSH_AUTH_SOCK;
      const computerHelper = process.env.DOGO_MAC_HELPER ?? path.join(process.resourcesPath, 'native/dogo-computer');
      if (process.platform === 'darwin' && existsSync(computerHelper)) env.DOGO_MAC_HELPER = computerHelper;
      host = new DesktopHost(directory, { nodeBinary, env,
        onOffline: () => {
          workspace?.backendChanged({ state: 'failed' });
          if (window && !window.isDestroyed()) window.webContents.send('dogo:snapshot', { ...(latest ?? { tasks: [], workspaces: [] }), runtime: 'offline' });
        },
        onSnapshot: snapshot => {
          const previous = new Map(
            (latest?.tasks ?? []).map((t) => [t.id, t.status]),
          );
          const previousHub = new Map((latest?.hub?.items ?? []).map(i => [i.id, `${i.state}:${i.status}:${i.answer ?? ''}`]));
          const hadHub = !!latest?.hub?.syncedAt;
          latest = snapshot;
          updateTray();
          workspace?.backendChanged(latest.backend);
          if (hadHub && !window?.isFocused() && Notification.isSupported()) {
            for (const item of latest.hub?.items ?? []) {
              const signature = `${item.state}:${item.status}:${item.answer ?? ''}`;
              if (previousHub.get(item.id) === signature) continue;
              const title = item.type === 'note' && !previousHub.has(item.id) ? 'DogO · 资料箱有新记录'
                : item.type === 'request' && item.state === 'pending' && !item.answer ? 'DogO · 需要你的确认'
                : item.type === 'command' && ['succeeded', 'failed', 'interrupted'].includes(item.status) ? 'DogO · 跨设备任务已结束' : '';
              if (title) new Notification({ title, body: '打开 DogO 查看。' }).show();
            }
          }
          for (const task of latest.tasks)
            if (
              previous.get(task.id) === "running" &&
              ["succeeded", "failed", "cancelled"].includes(task.status) &&
              !window?.isFocused() &&
              Notification.isSupported()
            )
              new Notification({
                title:
                  task.status === "succeeded"
                    ? "DogO · 任务完成"
                    : "DogO · 任务已结束",
                body: "打开 DogO 查看结果。",
              }).show();
          if (window && !window.isDestroyed())
            window.webContents.send("dogo:snapshot", latest);
        },
      });
      await host.start();
      session.defaultSession.setPermissionRequestHandler(
        (_webContents, _permission, callback) => callback(false),
      );
      session.defaultSession.setPermissionCheckHandler(() => false);
      window = new BrowserWindow({
        width: 1280,
        height: 840,
        minWidth: 940,
        minHeight: 640,
        title: "DogO",
        backgroundColor: "#f7f8f5",
        titleBarStyle: "hiddenInset",
        trafficLightPosition: { x: 20, y: 20 },
        webPreferences: {
          preload: fileURLToPath(new URL("preload.cjs", import.meta.url)),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          webSecurity: true,
        },
      });
      function trusted(event, allowWorkspace = false) {
        if (allowWorkspace && workspace?.trusted(event)) return;
        if (
          event.sender !== window.webContents ||
          event.senderFrame !== window.webContents.mainFrame ||
          event.senderFrame.url !== entryUrl
        )
          throw new Error("拒绝非应用主页面请求");
      }
      workspace = new DshWorkspace({
        window, createView: options => new WebContentsView(options),
        preload: fileURLToPath(new URL('./dsh-preload.cjs', import.meta.url)),
        getUrl: () => rpc('openDsh'), getBackend: () => latest?.backend,
        changed: value => { if (!window.isDestroyed()) window.webContents.send('dogo:workspace', value); },
        confirmExternal: async origin => {
          const result = await dialog.showMessageBox(window, { type: 'question',
            buttons: ['取消', '在浏览器打开'], defaultId: 0, cancelId: 0,
            message: 'DSH 请求打开外部页面', detail: `${origin}\n仅在你主动登录服务或打开链接时继续。` });
          return result.response === 1;
        },
        openExternal: url => shell.openExternal(url),
      });
      ipcMain.handle('dogo:workspaceSnapshot', event => { trusted(event); return workspace.snapshot(); });
      ipcMain.handle('dogo:account', (event, input) => { trusted(event, true); return account.execute(input); });
      ipcMain.handle('dogo:saveArtifact', async (event, input) => {
        trusted(event, true);
        if (!input || typeof input.id !== 'string' || !/^[a-f0-9-]{36}$/.test(input.id) || input.origin !== latest?.relay?.url) throw new Error('附件身份或服务地址无效');
        const call = args => rpc('hubAction', { op: 'artifactRead', args });
        const meta = await call({ id: input.id });
        if (!Number.isInteger(meta.size) || meta.size < 0 || meta.size > 8 * 1024 * 1024 || typeof meta.name !== 'string' || /[\x00-\x1f/\\]/.test(meta.name)) throw new Error('附件信息无效');
        const selected = await dialog.showSaveDialog(window, { title: '保存附件', defaultPath: path.join(app.getPath('downloads'), meta.name) });
        if (selected.canceled || !selected.filePath) return { saved: false };
        const chunks = [];
        for (let offset = 0, index = 0; offset < meta.size; offset += 192 * 1024, index++) chunks.push(Buffer.from((await call({ id: input.id, index })).data, 'base64'));
        const bytes = Buffer.concat(chunks);
        if (bytes.length !== meta.size || createHash('sha256').update(bytes).digest('hex') !== meta.sha256) throw new Error('附件校验失败，未写入目标文件');
        writeFileSync(selected.filePath, bytes, { mode: 0o600 }); return { saved: true };
      });
      ipcMain.handle('dogo:workspaceShow', (event, value) => { trusted(event); return workspace.show(workspaceVisibility(value)); });
      ipcMain.handle('dogo:workspaceReload', async event => { trusted(event); await workspace.load(true); return workspace.snapshot(); });
      window.on('closed', () => workspace.dispose());
      ipcMain.handle('dogo:prepare', async event => {
        trusted(event, true);
        return rpc('prepare', { screen: process.platform === 'darwin' ? systemPreferences.getMediaAccessStatus('screen') : 'unsupported',
          accessibility: process.platform === 'darwin' && systemPreferences.isTrustedAccessibilityClient(false) });
      });
      ipcMain.handle('dogo:memory', async (event, input) => {
        trusted(event, true);
        const result = await rpc('memoryAction', input);
        if (input.op !== 'export') return result;
        const selected = await dialog.showSaveDialog(window, { title: '导出 DogO 个人记忆', defaultPath: 'dogo-personal-memory.json', filters: [{ name: 'JSON', extensions: ['json'] }] });
        if (selected.canceled || !selected.filePath) return { saved: false };
        writeFileSync(selected.filePath, JSON.stringify(result, null, 2), { mode: 0o600 }); return { saved: true };
      });
      for (const method of [
        "snapshot",
        "configure",
        "create",
        "followup",
        "cancel",
        "refreshRelay",
        "acceptRemote",
        "hubAction",
        "remotePolicy",
        "updateProject",
        "hubCache",
        "memoryConfigure",
        "memorySync",
        "capabilitiesConfigure",
      ])
        ipcMain.handle(`dogo:${method}`, async (event, params) => {
          trusted(event, ['updateProject', 'remotePolicy', 'capabilitiesConfigure'].includes(method));
          if (['remotePolicy', 'capabilitiesConfigure', 'updateProject'].includes(method)) {
            const answer = await dialog.showMessageBox(window, { type: 'question', buttons: ['取消', '保存'], defaultId: 0, cancelId: 0, message: '修改 DogO 执行权限', detail: JSON.stringify(params, null, 2) });
            if (answer.response !== 1) throw new Error('已取消权限修改');
          }
          return rpc(method, params);
        });
      ipcMain.handle('dogo:registerProject', async (event) => {
        trusted(event, true);
        const selected = await dialog.showOpenDialog(window, { title: '登记项目文件夹（用于无人值守执行）', buttonLabel: '登记项目', properties: ['openDirectory'] });
        if (selected.canceled) return null;
        return rpc('registerProject', { path: selected.filePaths[0] });
      });
      ipcMain.handle('dogo:openMemory', async (event) => {
        trusted(event, true);
        const folder = path.join(directory, 'personal-memory'); mkdirSync(folder, { recursive: true, mode: 0o700 });
        const error = await shell.openPath(folder); if (error) throw new Error(error); return true;
      });
      ipcMain.handle('dogo:loginItem', (event, input) => {
        trusted(event, true);
        if (input?.enabled !== undefined) {
          if (typeof input.enabled !== 'boolean') throw new Error('无效自启设置');
          if (!app.isPackaged) throw new Error('请安装 DogO.app 后设置登录自启，开发版不会注册独立后台进程');
          app.setLoginItemSettings({ openAtLogin: input.enabled, type: 'mainAppService' });
        }
        return { ...app.getLoginItemSettings(), supported: app.isPackaged };
      });
      ipcMain.handle('dogo:openDsh', async (event) => {
        trusted(event);
        window.webContents.send('dogo:open-workspace');
        return true; // No URL or bootstrap token crosses renderer IPC.
      });
      if (existsSync(credentialFile) && encryptionReady()) {
        try {
          const pairing = pairingSchema.parse(JSON.parse(safeStorage.decryptString(readFileSync(credentialFile))));
          currentCredential = pairing;
          await rpc('connectRelay', pairing);
        } catch { console.error('DogO device connection could not be restored; re-import the device file in Settings.'); }
      }
      ipcMain.handle("dogo:chooseWorkspace", async (event) => {
        trusted(event);
        const result = await dialog.showOpenDialog(window, {
          title: "允许 DogO 只读访问此文件夹",
          buttonLabel: "授权只读访问",
          properties: ["openDirectory"],
        });
        if (result.canceled) return null;
        return rpc("authorizeWorkspace", { path: result.filePaths[0] });
      });
      ipcMain.handle("dogo:copyResult", async (event, id) => {
        trusted(event);
        if (typeof id !== "string") throw new Error("无效任务 ID");
        const state = await rpc("snapshot");
        const task = state.tasks.find((t) => t.id === id);
        if (!task) throw new Error("任务不存在");
        clipboard.writeText(task.output);
      });
      window.webContents.on("will-navigate", (event) => event.preventDefault());
      window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      window.on("close", (event) => {
        if (!quitting) {
          event.preventDefault();
          window.hide();
        }
      });
      const pixels = Buffer.alloc(16 * 16 * 4);
      for (let y = 3; y <= 12; y++)
        for (let x = 3; x <= 12; x++) {
          const visible =
            x <= 5 ||
            ((y <= 4 || y >= 11) && x <= 10) ||
            (x >= 11 && y >= 5 && y <= 10);
          if (visible) pixels[(y * 16 + x) * 4 + 3] = 255;
        }
      const icon = nativeImage.createFromBitmap(pixels, {
        width: 16,
        height: 16,
      });
      icon.setTemplateImage(true);
      tray = new Tray(icon);
      tray.setToolTip("DogO · 本地助理");
      tray.setContextMenu(
        Menu.buildFromTemplate([
          { label: "打开 DogO", click: show },
          { type: "separator" },
          { label: "退出 DogO", click: () => app.quit() },
        ]),
      );
      tray.on("click", show);
      updateTray();
      Menu.setApplicationMenu(
        Menu.buildFromTemplate([
          {
            label: "DogO",
            submenu: [
              { label: "显示 DogO", click: show },
              { role: "hide" },
              {
                label: "关闭窗口，保留后台",
                accelerator: "CmdOrCtrl+W",
                click: () => window.hide(),
              },
              { type: "separator" },
              {
                label: "退出 DogO",
                accelerator: "CmdOrCtrl+Q",
                click: () => app.quit(),
              },
            ],
          },
          { role: "editMenu" },
          { role: "windowMenu" },
        ]),
      );
      await window.loadFile(entryFile);
    })
    .catch(async (error) => {
      dialog.showErrorBox("DogO 启动失败", error.message);
      quitting = true;
      await host?.close().catch(() => {});
      app.exit(1);
    });
  app.on("before-quit", async (event) => {
    if (quitting) return;
    event.preventDefault();
    if (shutdownStarted) return;
    shutdownStarted = true;
    try {
      const state = await rpc("snapshot");
      const execution = await rpc('executionStatus');
      if (execution.active > 0 || execution.unknown || state.tasks.some((t) => t.status === "running") || state.hub?.items.some(i => i.type === 'command' && i.status === 'running')) {
        const answer = await dialog.showMessageBox(window, {
          type: "question",
          buttons: ["继续后台运行", "停止任务并退出"],
          defaultId: 0,
          cancelId: 0,
          message: "完整退出会停止本机任务",
          detail: execution.unknown ? '暂时无法确认 DSH 是否仍在执行。退出会停止执行器；只关闭窗口可继续后台运行。' : "包括 DSH 原生界面启动的任务。只关闭窗口不会停止任务；退出后不会自动重新执行。",
        });
        if (answer.response === 0) {
          shutdownStarted = false;
          return;
        }
      }
      await rpc("shutdown");
    } catch {
      await host?.close().catch(() => {});
    }
    quitting = true;
    workspace?.dispose();
    tray?.destroy();
    app.quit();
  });
}
