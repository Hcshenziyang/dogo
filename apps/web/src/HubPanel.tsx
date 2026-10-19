import { HubView } from '@dogo/hub-ui';
import { HubSession } from '@dogo/hub-ui/client';
import { bridge, type Snapshot } from './bridge';
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { AccountSettings } from '@dogo/hub-ui/account';
import { MemoryManager } from '@dogo/hub-ui/memory';

const client = new HubSession({
  saveArtifact: value => bridge.saveArtifact(value),
  async status() { const s = await bridge.snapshot(); return { configured: s.relay?.configured ?? false, url: s.relay?.url ?? '', device: s.relay?.device ?? '' }; },
  async hub({ origin, op, args }) { const s = await bridge.snapshot(); if (s.relay?.url !== origin) throw new Error('连接地址已改变'); return bridge.hubAction({ op, args }); },
}, { get: () => bridge.hubCache({}), set: value => bridge.hubCache({ value }) });

export function HubPanel({ state, action, mode = 'tasks', extra, onSettings }: { state?: Snapshot; action(fn: () => Promise<unknown>): unknown;
  mode?: 'tasks' | 'inbox' | 'settings'; extra?: ReactNode; onSettings?: () => void }) {
  const [login, setLogin] = useState({ openAtLogin: false, supported: false });
  useEffect(() => { void bridge.loginItem().then(setLogin); }, []);
  return <HubView client={client} desktop initialTab={mode} embedded onSettings={onSettings} settings={<>
    <AccountSettings call={bridge.account} changed={() => client.refresh()} />
    <section className="hub-card"><h3>无人值守准备检查</h3><button onClick={() => action(() => bridge.prepare())}>检查模型、DSH、插件和系统权限</button>
      {state?.readiness?.checks.map(c => <p key={c.id}>{c.ok ? '✓' : '待处理'} · {c.message}</p>)}<small>{state?.readiness?.at ? `检查于 ${new Date(state.readiness.at).toLocaleString()}；不自动点击系统授权` : '尚未检查'}</small></section>
    {state?.capabilities && <CapabilitySettings policy={state.capabilities.policy} save={value => action(() => bridge.capabilitiesConfigure(value))} />}
    <div className="hub-card"><h3>设备连接</h3><p>{state?.relay?.connected ? '中转服务已连接' : '中转服务未连接'}。本机工作区不依赖此连接。</p>
      <button onClick={() => action(() => bridge.importRelay())}>导入此设备配对文件</button><button onClick={() => action(() => bridge.refreshRelay())}>刷新连接</button>
      {state?.relay?.error && <p role="alert">{state.relay.error}</p>}
    </div>
    <div className="hub-card"><h3>无人值守执行</h3><p>开启后，已配对设备明确发送的任务自动进入本机 DSH。常规工具按 DSH 原权限运行，额外确认返回手机。资料不会触发执行。</p>
      <label><span><input type="checkbox" style={{ width: 'auto' }} checked={state?.hub?.policy.autoExecute ?? false} onChange={e => action(() => bridge.remotePolicy({ autoExecute: e.target.checked }))} /> 允许已配对设备自动执行</span></label>
      {state?.hub?.error && <p role="alert">{state.hub.error}</p>}
    </div>
    <div className="hub-card"><h3>本机项目</h3>{state?.hub?.projects.map(p => <ProjectEditor key={p.id} project={p} save={value => action(() => bridge.updateProject(value))} />)}<button onClick={() => action(() => bridge.registerProject())}>登记项目文件夹</button><p>只向手机发布名称、简介与状态，不同步路径和项目源码。撤销公开或执行权限后，未开始的任务不会继续使用该目录。</p></div>
    <MemoryManager key={state?.relay?.url} call={bridge.memory} scope={state?.relay?.url ?? 'local'} devices={state?.hub?.items.filter(i => i.type === 'device').map(d => ({ id: d.owner!, name: d.name! })) ?? []} />
    <button onClick={() => action(() => bridge.openMemory())}>打开专用记忆文件夹</button>
    <div className="hub-card"><h3>内置 DSH 工作区</h3><button onClick={() => action(() => bridge.openDsh())}>进入工作区 · 模型与插件</button><p>直接使用随应用安装的上游页面，不另开浏览器；会话与手机保持关联。完整退出 DogO 后不再接单。</p></div>
    <div className="hub-card"><h3>登录时启动 DogO</h3><label><span><input type="checkbox" style={{ width: 'auto' }} disabled={!login.supported} checked={login.openAtLogin} onChange={e => action(async () => setLogin(await bridge.loginItem({ enabled: e.target.checked })))} /> 系统登录后打开应用并恢复设备连接</span></label><p>{login.supported ? '关闭窗口保持在线；完全退出后停止接单。可在系统登录项中撤销。' : '安装完整 DogO.app 后可启用，不注册独立守护进程。'}</p></div>
    {extra}
  </>} />;
}

function CapabilitySettings({ policy, save }: { policy: NonNullable<Snapshot['capabilities']>['policy']; save(value: NonNullable<Snapshot['capabilities']>['policy']): unknown }) {
  const [value, setValue] = useState(policy), [hosts, setHosts] = useState(policy.sshHosts.join('\n'));
  return <section className="hub-card"><h3>本机能力授权</h3><p>开关只控制 DogO 提供的这些工具；DSH 自身终端、文件等权限独立管理。启用后包括已授权手机任务都可调用；撤销时终止对应本地操作。新能力默认关闭。</p>
    <label><span><input type="checkbox" style={{ width: 'auto' }} checked={value.computer} onChange={e => setValue({ ...value, computer: e.target.checked })} /> 屏幕、点击与输入（另需 macOS 系统授权）</span></label>
    <label><span><input type="checkbox" style={{ width: 'auto' }} checked={value.codex} onChange={e => setValue({ ...value, codex: e.target.checked })} /> Codex 编码委派（已登录 CLI，工作目录限于获准项目）</span></label>
    <p>Codex 使用 workspace-write 写入沙箱；读取范围遵循 Codex 原策略，不等于只能读取项目文件。</p>
    <label>允许 SSH 的本机 Host 别名，每行一个<textarea value={hosts} onChange={e => setHosts(e.target.value)} rows={3} /></label>
    <p>SSH 使用系统现有密钥与 known_hosts；不会跳过主机验证，不保存密码。断开不保证远端副作用回滚。</p>
    <button onClick={() => { if (confirm('保存这些本机操作权限？请确认已授权设备可以使用所选能力。')) save({ ...value, sshHosts: hosts.split(/\s+/).filter(Boolean) }); }}>保存能力权限</button></section>;
}

function ProjectEditor({ project, save }: { project: NonNullable<Snapshot['hub']>['projects'][number]; save: (value: Parameters<typeof bridge.updateProject>[0]) => unknown }) {
  const [name, setName] = useState(project.name), [summary, setSummary] = useState(project.summary);
  const [published, setPublished] = useState(project.published), [executionAllowed, setExecution] = useState(project.executionAllowed);
  return <details><summary>{project.name} · {project.available ? '可执行' : '未公开 / 不可执行'}</summary><small>{project.path}</small>
    <label>项目名称<input value={name} maxLength={200} onChange={e => setName(e.target.value)} /></label><label>简介<textarea value={summary} maxLength={1000} onChange={e => setSummary(e.target.value)} /></label>
    <label><span><input type="checkbox" style={{ width: 'auto' }} checked={published} onChange={e => setPublished(e.target.checked)} /> 向已授权设备公开</span></label>
    <label><span><input type="checkbox" style={{ width: 'auto' }} checked={executionAllowed} onChange={e => setExecution(e.target.checked)} /> 允许任务在此目录执行</span></label>
    <button onClick={() => { if (confirm('保存此项目的公开和执行权限？此操作不移动或删除目录。')) save({ id: project.id, name, summary, published, executionAllowed }); }}>保存项目设置</button>
  </details>;
}
