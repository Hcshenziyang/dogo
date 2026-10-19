// DogO owns this host, not the upstream page. No DOM injection, route scraping,
// copied DSH UI or privileged preload: upstream UI changes stay inside the view.
export const WORKSPACE_TOP = 64;

export function localWorkspaceUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password)
    throw new Error('拒绝无效的 DSH 本机地址');
  return url;
}

export function sameWorkspace(value, origin) {
  try { const url = localWorkspaceUrl(value); return url.origin === origin; } catch { return false; }
}

export function externalWorkspaceUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || value.length > 8192) return null;
    return url;
  } catch { return null; }
}

export function workspaceVisibility(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).length !== 1 || typeof value.visible !== 'boolean') throw new Error('无效工作区参数');
  return value.visible;
}

export class DshWorkspace {
  constructor({ window, createView, getUrl, getBackend, changed, confirmExternal, openExternal }) {
    Object.assign(this, { window, createView, getUrl, getBackend, changed, confirmExternal, openExternal });
    this.phase = 'idle'; this.message = ''; this.visible = false; this.epoch = 0;
    this.resize = () => this.layout();
    window.on('resize', this.resize);
  }
  snapshot() { return { phase: this.phase, message: this.message, visible: this.visible }; }
  publish(phase, message = '') {
    this.phase = phase; this.message = message; this.layout(); this.changed(this.snapshot());
  }
  layout() {
    if (!this.view || this.window.isDestroyed()) return;
    const [width, height] = this.window.getContentSize();
    this.view.setBounds({ x: 0, y: WORKSPACE_TOP, width, height: Math.max(0, height - WORKSPACE_TOP) });
    const visible = this.visible && this.phase === 'ready';
    // Detach without destroying the document: hidden pages must also leave the AX tree.
    if (visible && !this.attached) { this.window.contentView.addChildView(this.view); this.attached = true; }
    if (!visible && this.attached) { this.window.contentView.removeChildView(this.view); this.attached = false; }
    this.view.setVisible(visible);
  }
  async show(visible) {
    if (this.disposed) return this.snapshot();
    this.visible = visible; this.layout(); this.changed(this.snapshot());
    if (visible) await this.load();
    return this.snapshot();
  }
  async external(value) {
    const url = externalWorkspaceUrl(value);
    if (!url) { this.message = '已阻止不受支持的外部链接。'; this.changed(this.snapshot()); return; }
    if (this.confirming || !this.visible || this.disposed) return;
    this.confirming = true;
    try {
      // Show only the destination origin; OAuth query strings may contain credentials.
      if (await this.confirmExternal(url.origin) && !this.disposed) await this.openExternal(url.href);
    } catch { this.message = '未能打开外部浏览器。'; this.changed(this.snapshot()); }
    finally { this.confirming = false; }
  }
  attach() {
    if (this.view) return;
    const view = this.createView({ webPreferences: {
      partition: 'persist:dogo-dsh-workspace', contextIsolation: true, sandbox: true,
      nodeIntegration: false, nodeIntegrationInSubFrames: false, webviewTag: false,
      webSecurity: true, allowRunningInsecureContent: false,
    } });
    this.view = view;
    view.setVisible(false);
    const contents = view.webContents;
    contents.session.setPermissionCheckHandler((sender, permission, origin) =>
      sender === contents && permission === 'clipboard-sanitized-write' && sameWorkspace(origin, this.origin));
    contents.session.setPermissionRequestHandler((sender, permission, callback, details) =>
      callback(sender === contents && permission === 'clipboard-sanitized-write' &&
        sameWorkspace(details.requestingUrl || contents.getURL(), this.origin)));
    contents.on('will-attach-webview', event => event.preventDefault());
    const navigate = event => {
      if (sameWorkspace(event.url, this.origin)) return;
      event.preventDefault();
      if (event.isMainFrame) void this.external(event.url);
    };
    contents.on('will-frame-navigate', navigate);
    contents.on('will-redirect', event => {
      if (!sameWorkspace(event.url, this.origin)) event.preventDefault();
    });
    contents.setWindowOpenHandler(({ url }) => {
      if (sameWorkspace(url, this.origin)) {
        void contents.loadURL(url).catch(() => this.publish('error', '工作区页面未能打开，请重新连接。'));
      } else void this.external(url);
      return { action: 'deny' };
    });
    contents.on('render-process-gone', () => {
      this.loaded = false;
      this.publish('error', '工作区页面已退出。任务仍由后端管理，重新连接不会重复执行任务。');
    });
    contents.on('did-fail-load', (_event, code, _description, _url, isMainFrame) => {
      if (isMainFrame && code !== -3) {
        this.loaded = false;
        this.publish('error', '工作区页面加载失败，请重新连接；不会重新提交任务。');
      }
    });
  }
  async load(force = false) {
    if (this.disposed || (!force && this.loaded)) return;
    if (this.loading) return this.loading;
    const epoch = this.epoch;
    this.publish('loading', '正在连接本机 DSH，不经过中转服务器…');
    this.loading = (async () => {
      try {
        // The bootstrap URL stays in the main process and isolated upstream view.
        const url = localWorkspaceUrl(await this.getUrl());
        if (this.disposed || this.epoch !== epoch) return;
        this.origin = url.origin;
        this.attach();
        await this.view.webContents.loadURL(url.href);
        if (this.disposed || this.epoch !== epoch) return;
        this.generation = this.getBackend()?.generation;
        this.loaded = true;
        this.publish('ready');
      } catch {
        if (!this.disposed && this.epoch === epoch) {
          this.loaded = false;
          this.publish('error', '无法连接本机工作区。请检查 DSH 后端状态后重试；原有会话不会被删除或重新执行。');
        }
      }
    })();
    try { await this.loading; } finally { this.loading = undefined; }
  }
  backendChanged(backend) {
    if (!this.view || this.loading || this.disposed) return;
    if (backend?.state !== 'ready') {
      this.loaded = false;
      this.publish('error', '本机 DSH 暂不可用。原会话保留，恢复后重新连接。');
    } else if (backend.generation && backend.generation !== this.generation) {
      this.loaded = false;
      if (this.visible) void this.load();
      else this.publish('idle');
    }
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true; this.epoch++;
    this.window.removeListener('resize', this.resize);
    if (this.view) {
      this.view.webContents.session.flushStorageData();
      if (this.attached && !this.window.isDestroyed()) this.window.contentView.removeChildView(this.view);
      if (!this.view.webContents.isDestroyed()) this.view.webContents.close({ waitForBeforeUnload: false });
    }
  }
}
