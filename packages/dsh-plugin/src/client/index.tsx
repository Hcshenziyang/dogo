import React, { useEffect, useMemo, useState } from 'react';
import { HubView } from '@dogo/hub-ui';
import { HubSession } from '@dogo/hub-ui/client';
import { MemoryManager } from '@dogo/hub-ui/memory';
import { AccountSettings } from '@dogo/hub-ui/account';
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

export const inject = ['slots', 'layout'];
function createClient(scope: string) {
  return new HubSession({
    saveArtifact: value => native('saveArtifact', value),
    async status() { const s = await call('snapshot'); return { configured: s.relay.configured, url: s.relay.url, device: s.relay.device }; },
    async hub({ origin, op, args }) { if (!scope.startsWith(origin + '|')) throw new Error('连接身份已改变'); return call('hubAction', { op, args, scope }); },
  }, { get: () => call('hubCache', { scope }), set: value => call('hubCache', { scope, value }) });
}
export function apply(ctx: any) {
  const Panel = () => <DogOPanel />;
  const Icon = ({ size = 18 }: { size?: number }) => <span style={{ fontSize: size }} aria-hidden="true">D</span>;
  ctx.effect(() => {
    const style = document.createElement('style'); style.textContent = css + '\n.dogo-plugin{height:100%;overflow:auto;padding:var(--dsh-frame-top-clearance,16px) 16px 16px}.dogo-plugin .hub-shell{height:auto;min-height:600px}.dogo-plugin input[type=checkbox]{width:auto}';
    document.head.append(style); return () => style.remove();
  });
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'dogo' }, Panel));
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: 'dogo', order: 10, label: () => 'DogO · 跨端与资料' }, Icon));
}
function DogOPanel() {
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
  return <div className="dogo-plugin"><h1>DogO</h1>{error && <p role="alert">{error}</p>}
    <HubView key={scope} client={client} desktop settings={<>
      {hasNative ? <AccountSettings call={account} changed={() => client.refresh()} /> : <p>当前为浏览器连接。本机账号、设备授权请在 DogO 桌面客户端中管理。</p>}
      <section className="hub-card"><h3>设备与连接</h3><p>{state?.relay.connected ? '跨端已连接' : '跨端未连接；本机 DSH 会话仍可用'}</p>
        <button onClick={() => void run(() => call('refreshRelay'))}>刷新</button>
        {hasNative && <><button onClick={() => void run(() => native('importRelay'))}>导入已有设备凭据</button><button onClick={() => void run(() => native('prepare'))}>准备检查</button>
          <label><input type="checkbox" checked={state?.hub.policy.autoExecute ?? false} onChange={e => void run(() => native('remotePolicy', { autoExecute: e.target.checked }))} />允许已授权设备自动执行</label>
          <button onClick={() => void run(() => native('registerProject'))}>登记项目文件夹</button>
          {state?.hub.projects.map((p: any) => <Project key={p.id} project={p} run={run} />)}
          <NativeSettings policy={state?.capabilities.policy} run={run} />
        </>}
        {state?.readiness?.checks.map((c: any) => <p key={c.id}>{c.ok ? '✓' : '待处理'} · {c.message}</p>)}
        {state?.hub.error && <p role="alert">{state.hub.error}</p>}
      </section>
      <MemoryManager key={state ? `${state.relay.url}|${state.relay.device}` : 'local'} scope={state ? `${state.relay.url}|${state.relay.device}` : 'local'} call={memory}
        devices={state?.hub.items.filter((i: any) => i.type === 'device').map((i: any) => ({ id: i.owner, name: i.name })) ?? []} />
      {hasNative && <button onClick={() => void run(() => native('openMemory'))}>打开个人记忆目录</button>}
      <section className="hub-card"><h3>历史任务</h3><p>旧任务保留查看；新会话使用 DSH 工作区。</p>{state?.tasks.map((t: any) => <details key={t.id}><summary>{t.title} · {t.status}</summary><pre style={{ whiteSpace: 'pre-wrap' }}>{t.output || t.error}</pre></details>)}</section>
    </>} />
  </div>;
}
function NativeSettings({ policy, run }: any) {
  const [value, setValue] = useState<any>(), [hosts, setHosts] = useState('');
  const [login, setLogin] = useState<any>();
  useEffect(() => { if (policy && !value) { setValue(policy); setHosts(policy.sshHosts.join('\n')); } }, [policy]);
  useEffect(() => { void native('loginItem').then(setLogin).catch(() => {}); }, []);
  if (!value) return null;
  return <section className="hub-card"><h3>本机能力</h3><p>权限由原生客户端确认；DSH 自身工具权限独立管理。</p>
    <label><input type="checkbox" checked={value.computer} onChange={e => setValue({ ...value, computer: e.target.checked })} />电脑操作（需支持的平台与系统授权）</label>
    <label><input type="checkbox" checked={value.codex} onChange={e => setValue({ ...value, codex: e.target.checked })} />Codex 编码委派</label>
    <label>SSH Host 别名<textarea value={hosts} onChange={e => setHosts(e.target.value)} /></label>
    <button onClick={() => void run(() => native('capabilitiesConfigure', { ...value, sshHosts: hosts.split(/\s+/).filter(Boolean) }))}>保存权限</button>
    {login && <label><input type="checkbox" disabled={!login.supported} checked={login.openAtLogin} onChange={e => void run(async () => setLogin(await native('loginItem', { enabled: e.target.checked })))} />登录系统时启动 DogO</label>}
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
