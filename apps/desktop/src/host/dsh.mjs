import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, access, symlink, realpath, lstat, rename } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { workspacePort } from './workspace-port.mjs';

const require = createRequire(import.meta.url);
const cli = path.join(path.dirname(require.resolve('@deepseek-ai/dsh/package.json')), 'lib/bin.js');
const plugin = '@dogo/dsh-plugin';
const exists = async (file) => access(file).then(() => true, () => false);
const bundledPlugins = { '@dogo/dsh-plugin': '0.1.0', 'dsh-codex': '0.3.2', 'dsh-native-memory': '0.2.0' };

async function prepareProfile(home) {
  const directory = path.join(home, 'profiles/dogo');
  await mkdir(path.join(directory, 'node_modules'), { recursive: true, mode: 0o700 });
  const manifest = path.join(directory, 'package.json');
  if (!(await exists(manifest))) {
    await writeFile(manifest, JSON.stringify({ name: 'dsh-profile-dogo', private: true,
      dependencies: bundledPlugins,
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', ...Object.keys(bundledPlugins).filter(name => name !== '@dogo/dsh-plugin')] } },
    }, null, 2), { flag: 'wx', mode: 0o600 });
    await writeFile(path.join(directory, 'cordis.patch.yml'),
      stringifyYaml([{ id: 'session-log-deepseek', config: { enabled: false } },
        { id: 'workspace-controller', config: { documentsDirectory: path.join(home, 'workspaces') } }]), { flag: 'wx', mode: 0o600 })
      .catch((error) => { if (error.code !== 'EEXIST') throw error; });
  }
  for (const name of Object.keys(bundledPlugins)) {
    const link = path.join(directory, 'node_modules', name);
    await mkdir(path.dirname(link), { recursive: true, mode: 0o700 });
    const source = await realpath(path.dirname(require.resolve(name + '/package.json')));
    const info = await lstat(link).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (!info) await symlink(source, link, process.platform === 'win32' ? 'junction' : 'dir');
    else if (info.isSymbolicLink() && await realpath(link).catch(() => '') !== source) {
      // Refresh only DogO's dependency links after an app upgrade; preserve manually installed directories.
      const next = `${link}.${randomUUID()}.next`;
      await symlink(source, next, process.platform === 'win32' ? 'junction' : 'dir');
      await rename(next, link);
    }
  }
}

export class DshBackend {
  constructor(directory, changed = () => {}, options = {}) {
    this.options = options;
    this.directory = directory;
    this.home = path.join(directory, 'dsh');
    this.changed = changed;
    this.state = 'stopped';
    this.error = '';
  }
  snapshot() { return { state: this.state, error: this.error, version: '0.2.0-rc.2', generation: this.generation }; }
  status(state, error = '') { this.state = state; this.error = error; this.changed(); }
  async ensure(settings) {
    const key = JSON.stringify([settings.endpoint, settings.model, settings.contextWindow, settings.maxTokens, this.personalMemoryPath]);
    if (this.starting) await this.starting;
    if (this.child && this.state === 'ready' && this.key === key) return;
    if (this.child && this.state === 'ready' && (await this.request('/health')).activeAgents > 0)
      throw new Error('DSH 原生会话仍在运行，请先完成或停止，再应用新配置');
    this.starting = this.start(settings, key);
    try { await this.starting; } finally { this.starting = undefined; }
  }
  async start(settings, key) {
    await this.stop();
    await this.beforeStart?.();
    this.status('starting');
    await mkdir(this.home, { recursive: true, mode: 0o700 });
    if (this.personalMemoryPath) await mkdir(this.personalMemoryPath, { recursive: true, mode: 0o700 });
    await prepareProfile(this.home);
    const defaultWorkspace = path.join(this.home, 'workspaces/default');
    await mkdir(defaultWorkspace, { recursive: true, mode: 0o700 });
    this.key = key;
    this.token = randomBytes(32).toString('hex');
    const launchId = randomUUID();
    this.generation = launchId; // Non-secret instance marker; lets the embedded view reconnect after a restart.
    const overlay = path.join(this.home, 'dogo.generated.patch.json');
    const provider = {
      api: 'openai-completions', baseURL: settings.endpoint, apiKeyEnv: 'DOGO_LOCAL_MODEL_KEY',
      displayName: 'DogO 本地模型', reasoning: 'off', retryPolicy: { mode: 'normal', maxRetries: 0 },
      models: settings.model ? [{ id: settings.model, name: settings.model, input: ['text'],
        reasoning: false, contextWindow: settings.contextWindow, maxTokens: settings.maxTokens }] : [],
      compat: { supportsDeveloperRole: false, supportsStore: false, supportsReasoningEffort: false, maxTokensField: 'max_tokens' },
    };
    if (this.options.hostServices && !(await exists(path.join(this.home, 'dogo-model-import.json')))) {
      const configFile = path.join(this.home, 'profiles/dogo/cordis.patch.yml');
      const text = await readFile(configFile, 'utf8');
      const patches = parseYaml(text);
      if (!Array.isArray(patches)) throw new Error('无法安全迁移 DSH profile；原文件保留');
      if (settings.model) {
        if (!patches.some(row => row.id === 'llm-pi-ai')) patches.push({ id: 'llm-pi-ai', config: { providers: { 'dogo-local': provider } } });
        if (!patches.some(row => row.id === 'agent-default-model') && patches.some(row => row.id === 'llm-pi-ai' && row.config?.providers?.['dogo-local'])) patches.push({ id: 'agent-default-model', config: { provider: 'dogo-local', model: settings.model } });
        await writeFile(configFile + '.pre-dogo-plugin', text, { flag: 'wx', mode: 0o600 }).catch(e => { if (e.code !== 'EEXIST') throw e; });
        await writeFile(configFile + '.tmp', stringifyYaml(patches), { mode: 0o600 });
        await rename(configFile + '.tmp', configFile);
      }
      await writeFile(path.join(this.home, 'dogo-model-import.json'), JSON.stringify({ version: 1 }), { mode: 0o600, flag: 'wx' });
    }
    await writeFile(overlay, JSON.stringify([
      ...(!this.options.hostServices ? [
        { id: 'llm-pi-ai', config: { providers: { 'dogo-local': provider } } },
        ...(settings.model ? [{ id: 'agent-default-model', config: { provider: 'dogo-local', model: settings.model } }] : []),
      ] : []),
      ...(this.options.hostServices ? [{ id: 'dsh-native-memory', config: { injectProfile: false } }] : []),
      { id: 'web-runtime', config: { openBrowser: false, printUrl: false, surfaceContext: true, trustedHosts: [] } },
      { insert: [
        { id: 'preset-dogo-readonly', name: '@deepseek-ai/dsh-agent-preset', config: {
          id: 'dogo-readonly', order: 20,
          plugins: [{ id: 'compaction', name: 'cordis:group', group: true,
            isolate: { compaction: true }, config: [
              { id: 'compaction-basic', name: '@deepseek-ai/dsh-compaction-basic', config: {
                thresholdRatio: 0.75, headroomTokens: Math.min(2048, Math.floor(settings.contextWindow / 16)),
                retainRatio: 0.16, maxTokens: Math.min(2048, settings.maxTokens),
              } },
              { id: 'command-compact', name: '@deepseek-ai/dsh-command-compact' },
            ] }],
        } },
        { id: 'dogo-bridge', name: plugin },
      ] },
    ], null, 2), { mode: 0o600 });
    const args = [cli, '--profile', 'dogo'];
    args.push('--patch', overlay, '--host', '127.0.0.1', '--port', String(await workspacePort(this.home)), '--no-open');
    const env = Object.fromEntries(['HOME', 'USERPROFILE', 'PATH', 'TMPDIR', 'TEMP', 'SystemRoot', 'LANG']
      .filter((k) => process.env[k]).map((k) => [k, process.env[k]]));
    const child = spawn(this.options.nodeBinary ?? process.execPath, args, {
      cwd: defaultWorkspace,
      env: { ...env, ...this.options.env, DOGO_HOST_SERVICES: this.options.hostServices ? '1' : '0', DOGO_DATA_DIR: this.directory, DSH_HOME: this.home, DSH_TELEMETRY_DISABLED: '1', DSH_PRIMARY_RUNTIME: '',
        DSH_CODEX_MODELS_CACHE: path.join(this.home, 'codex-models-cache.json'),
        DOGO_BRIDGE_TOKEN: this.token, DOGO_LAUNCH_ID: launchId, DOGO_LOCAL_MODEL_KEY: 'dogo-local',
        ...(this.personalMemoryPath ? { DOGO_PERSONAL_MEMORY: this.personalMemoryPath } : {}),
        ...(this.capabilities ? { DOGO_CAPABILITY_URL: this.capabilities.url, DOGO_CAPABILITY_TOKEN: this.capabilities.token } : {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    this.tail = '';
    const capture = (chunk) => {
      // Never forward native DSH authenticated URLs or credential-shaped log values to the UI.
      this.tail = (this.tail + chunk.toString().replace(/https?:\/\/[^\s]+/g, '[url]')
        .replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]+\b/g, '[token]')
        .replaceAll(this.token, '[redacted]')).slice(-6000);
    };
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);
    child.stdin.on('error', () => {});
    child.on('error', (error) => { this.spawnError = error; });
    child.on('exit', () => {
      if (this.child === child && this.state === 'ready') this.status('failed', 'DSH 已退出，请重新打开后端');
    });
    this.spawnError = undefined;
    try {
      const deadline = Date.now() + 60000;
      while (Date.now() < deadline) {
        if (this.spawnError || child.exitCode !== null || child.signalCode !== null)
          throw new Error(`DSH 启动失败：${this.spawnError?.message ?? this.tail.slice(-2500)}`);
        let ready;
        try { ready = JSON.parse(await readFile(path.join(this.home, 'bridge-ready.json'), 'utf8')); } catch {}
        if (ready?.launchId === launchId && ready.pid === child.pid && Number.isInteger(ready.port) && ready.port > 0 && ready.port < 65536) {
          this.url = `http://127.0.0.1:${ready.port}`;
          const health = await this.request('/health');
          if (!health.ready || new URL(health.webUrl).origin !== this.url) throw new Error('DSH 返回了无效的本机地址');
          this.webUrl = health.webUrl;
          this.plugins = health.plugins;
          this.status('ready');
          return;
        }
        await delay(100);
      }
      throw new Error(`DSH 启动超时：${this.tail.slice(-2500)}`);
    } catch (error) {
      await this.stop();
      this.status('failed', error.message);
      throw error;
    }
  }
  async request(route, body, signal, timeoutMs = 15000) {
    const timeout = AbortSignal.timeout(timeoutMs);
    const response = await fetch(this.url + '/dogo' + route, {
      method: body ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${this.token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      redirect: 'error',
    });
    let value;
    try { value = await response.json(); }
    catch { throw new Error(`DSH 桥接返回非 JSON 响应（HTTP ${response.status}）`); }
    if (!response.ok) { const error = new Error(value.error || `DSH HTTP ${response.status}`); error.status = response.status; throw error; }
    return value;
  }
  async stop() {
    const child = this.child;
    this.child = undefined;
    this.webUrl = undefined;
    this.url = undefined;
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.stdin.end();
      const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
      await exited;
      clearTimeout(timer);
    }
    this.status('stopped');
  }
  async close() {
    if (this.starting) await this.starting.catch(() => {});
    await this.stop();
  }
}
