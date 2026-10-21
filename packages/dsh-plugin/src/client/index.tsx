import React, { useEffect, useMemo, useState } from 'react';
import { HubView } from '@dogo/hub-ui';
import { HubSession } from '@dogo/hub-ui/client';
import { MemoryManager } from '@dogo/hub-ui/memory';
import { AccountSettings } from '@dogo/hub-ui/account';
import desktopCss from './desktop.css?inline';
import css from '@dogo/hub-ui/style.css?inline';

const native = (method: string, params?: unknown): Promise<any> => {
  const bridge = (window as any).dogoNative;
  return bridge ? bridge.call(method, params) : Promise.reject(new Error('此操作需要 DogO 桌面客户端'));
};
async function call(method: string, params?: unknown) {
  const response = await fetch('/dogo-client', { method: 'POST', credentials: 'same-origin', redirect: 'error',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ method, params }), signal: AbortSignal.timeout(['memoryAction', 'memorySync', 'refreshRelay'].includes(method) ? 90000 : 30000) });
  const value = await response.json(); if (!response.ok) throw new Error(value.error || 'DogO 插件连接失败'); return value.result;
}
const memory = (input: any) => input.op === 'export' && (window as any).dogoNative ? native('memory', input) : call('memoryAction', input);
const account = (input: any) => native('account', input);

export const inject = ['slots', 'layout', 'uiWorkspace'];
function createClient(scope: string) {
  return new HubSession({
    saveArtifact: value => native('saveArtifact', value),
    async status() { const s = await call('snapshot'); return { configured: s.relay.configured, url: s.relay.url, device: s.relay.device }; },
    async hub({ origin, op, args }) { if (!scope.startsWith(origin + '|')) throw new Error('连接身份已改变'); return call('hubAction', { op, args, scope }); },
  }, { get: () => call('hubCache', { scope }), set: value => call('hubCache', { scope, value }) });
}
export function apply(ctx: any) {
  const Panel = () => <DogOPanel openConversation={() => ctx.layout.selectPanel(null)} openSession={(id: string) => ctx.uiWorkspace.openSession(id)} />;
  const Icon = ({ size = 18 }: { size?: number }) => <span style={{ fontSize: size }} aria-hidden="true">D</span>;
  ctx.effect(() => {
    const style = document.createElement('style'); style.textContent = css + desktopCss;
    document.head.append(style); return () => style.remove();
  });
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'dogo' }, Panel));
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: 'dogo', order: 10, label: () => 'DogO · 跨端与资料' }, Icon));
}
function DogOPanel({ openSession, openConversation }: { openSession(id: string): void; openConversation(): void }) {
  const [state, setState] = useState<any>(), [error, setError] = useState('');
  useEffect(() => {
    let live = true, pending = false;
    const refresh = async () => { if (pending) return; pending = true; try { const s = await call('snapshot'); if (live) setState(s); } catch (e) { if (live) setError((e as Error).message); } finally { pending = false; } };
    void refresh(); const timer = setInterval(refresh, 2000); return () => { live = false; clearInterval(timer); };
  }, []);
  const run = async (fn: () => Promise<any>) => { setError(''); try { await fn(); setState(await call('snapshot')); } catch (e) { setError((e as Error).message); } };
  const scope = state?.relay.configured ? `${state.relay.url}|${state.relay.device}` : 'local';
  const client = useMemo(() => createClient(scope), [scope]);
  const hasNative = !!(window as any).dogoNative;
  return <div className="dogo-plugin">{error && <p role="alert">{error}</p>}
    <HubView key={scope} client={client} desktop initialTab="inbox"
      localIdentity={{ device: state?.relay.device, instance: state?.hub.instance }} openNativeSession={openSession} openNativeConversation={openConversation}
      settings={<DesktopSettings state={state} scope={scope} client={client} hasNative={hasNative} run={run} />} />
  </div>;
}
const categories = [
  ['account', '账号与设备', '登录、配对与设备授权'],
  ['connection', '跨端连接', '连接状态与自动执行'],
  ['memory', '记忆与同步', '查看、纠正与管理助理记忆'],
  ['permissions', '本机权限', '电脑操作、Codex 与 SSH'],
  ['projects', '项目文件夹', '管理可访问的项目与执行权限'],
  ['general', '通用', '登录系统时启动'],
  ['history', '历史记录', '查看旧版任务'],
] as const;
function DesktopSettings({ state, scope, client, hasNative, run }: any) {
  const [page, setPage] = useState('');
  const title = categories.find(c => c[0] === page)?.[1];
  return <div className="dogo-settings">
    {page ? <><button className="hub-text" onClick={() => setPage('')}>← 返回设置</button><h2>{title}</h2></> :
      <div className="dogo-settings-list">{categories.map(([id, name, description]) => <button key={id} onClick={() => setPage(id)}><span><strong>{name}</strong><small>{description}</small></span><span aria-hidden="true">›</span></button>)}</div>}
    {page === 'account' && (hasNative ? <AccountSettings call={account} changed={() => client.refresh()} /> : <p>请在 DogO 桌面客户端中管理账号与设备授权。</p>)}
    {page === 'connection' && <section className="hub-card"><h3>{state?.relay.connected ? '跨端已连接' : '跨端未连接'}</h3><p className="hub-muted">本机对话不依赖跨端连接。</p>
      <button onClick={() => void run(() => call('refreshRelay'))}>刷新连接</button>
      {hasNative && <><button onClick={() => void run(() => native('importRelay'))}>导入设备凭据</button>
        <label><input type="checkbox" checked={state?.hub.policy.autoExecute ?? false} onChange={e => void run(() => native('remotePolicy', { autoExecute: e.target.checked }))} />允许已授权设备自动执行</label>
        <details><summary>连接诊断</summary><button onClick={() => void run(() => native('prepare'))}>运行检查</button>{state?.readiness?.checks.map((c: any) => <p key={c.id}>{c.ok ? '✓' : '待处理'} · {c.message}</p>)}</details></>}
      {state?.hub.error && <p role="alert">{state.hub.error}</p>}
      {state?.hub.items.filter((i: any) => i.type === 'device').map((d: any) => <p key={d.id}>{d.name} · {d.online ? '在线' : '离线'}</p>)}
    </section>}
    {page === 'memory' && <><MemoryManager scope={scope} call={memory} devices={state?.hub.items.filter((i: any) => i.type === 'device').map((i: any) => ({ id: i.owner, name: i.name })) ?? []} />
      {hasNative && <button onClick={() => void run(() => native('openMemory'))}>打开记忆目录</button>}</>}
    {page === 'permissions' && (hasNative ? <NativeSettings policy={state?.capabilities.policy} run={run} /> : <p>请在桌面客户端中管理本机权限。</p>)}
    {page === 'projects' && <section className="hub-card">{hasNative ? <><button onClick={() => void run(() => native('registerProject'))}>添加项目文件夹</button>{state?.hub.projects.map((p: any) => <Project key={p.id} project={p} run={run} />)}{!state?.hub.projects.length && <p className="hub-muted">尚未添加项目文件夹。</p>}</> : <p>请在桌面客户端中管理项目文件夹。</p>}</section>}
    {page === 'general' && (hasNative ? <GeneralSettings run={run} /> : <p>请在桌面客户端中管理启动设置。</p>)}
    {page === 'history' && <section className="hub-card"><p className="hub-muted">旧版任务只读保留。当前对话在 DSH 会话中查看。</p>{state?.tasks.map((t: any) => <details key={t.id}><summary>{t.title} · {t.status}</summary><pre>{t.output || t.error}</pre></details>)}{!state?.tasks.length && <p>暂无旧版任务。</p>}</section>}
  </div>;
}
function GeneralSettings({ run }: any) {
  const [login, setLogin] = useState<any>(), [error, setError] = useState('');
  useEffect(() => { void native('loginItem').then(setLogin).catch(e => setError(e.message)); }, []);
  return <section className="hub-card">{error && <p role="alert">{error}</p>}{login ? <label><input type="checkbox" disabled={!login.supported} checked={login.openAtLogin} onChange={e => void run(async () => setLogin(await native('loginItem', { enabled: e.target.checked })))} />登录系统时启动 DogO</label> : !error && <p>正在读取设置…</p>}</section>;
}

function NativeSettings({ policy, run }: any) {
  const [value, setValue] = useState<any>(), [hosts, setHosts] = useState('');
  useEffect(() => { if (policy && !value) { setValue(policy); setHosts(policy.sshHosts.join('\n')); } }, [policy]);
  if (!value) return null;
  return <section className="hub-card"><h3>本机能力</h3><p>权限由原生客户端确认；DSH 自身工具权限独立管理。</p>
    <label><input type="checkbox" checked={value.computer} onChange={e => setValue({ ...value, computer: e.target.checked })} />电脑操作（需支持的平台与系统授权）</label>
    <label><input type="checkbox" checked={value.codex} onChange={e => setValue({ ...value, codex: e.target.checked })} />Codex 编码委派</label>
    <label>SSH Host 别名<textarea value={hosts} onChange={e => setHosts(e.target.value)} /></label>
    <button onClick={() => void run(() => native('capabilitiesConfigure', { ...value, sshHosts: hosts.split(/\s+/).filter(Boolean) }))}>保存权限</button>
  </section>;
}
function Project({ project, run }: any) {
  const [value, setValue] = useState(project);
  return <details><summary>{project.name} · {project.available ? '可执行' : '不可执行'}</summary>
    <label>名称<input value={value.name} onChange={e => setValue({ ...value, name: e.target.value })} /></label>
    <label>说明<input value={value.summary} onChange={e => setValue({ ...value, summary: e.target.value })} /></label>
    <label><input type="checkbox" checked={value.published} onChange={e => setValue({ ...value, published: e.target.checked })} />公开项目</label>
    <label><input type="checkbox" checked={value.executionAllowed} onChange={e => setValue({ ...value, executionAllowed: e.target.checked })} />允许执行</label>
    <button onClick={() => void run(() => native('updateProject', { id: project.id, name: value.name, summary: value.summary, published: value.published, executionAllowed: value.executionAllowed }))}>保存项目权限</button>
  </details>;
}
