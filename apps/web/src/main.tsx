import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Inbox, MessageSquare, Settings2, RefreshCw, ArrowLeft } from 'lucide-react';
import { bridge, isPreview, type Snapshot, type WorkspaceViewState } from './bridge';
import { HubPanel } from './HubPanel';
import LegacyApp from './LegacyApp';
import './style.css';
import './workspace.css';

type Page = 'workspace' | 'inbox' | 'settings' | 'history' | 'remote';

function App() {
  const [page, setPage] = useState<Page>('workspace');
  const [state, setState] = useState<Snapshot>();
  const [workspace, setWorkspace] = useState<WorkspaceViewState>({ phase: 'idle', message: '', visible: true });
  const [error, setError] = useState('');
  const [legacyPage, setLegacyPage] = useState('tasks');
  useEffect(() => {
    let live = true;
    const receive = (value: Snapshot) => { if (live) setState(value); };
    const receiveWorkspace = (value: WorkspaceViewState) => { if (live) setWorkspace(value); };
    const off = bridge.subscribe(receive);
    const offWorkspace = bridge.onWorkspace(receiveWorkspace);
    const offOpen = bridge.onOpenWorkspace(() => { setPage('workspace'); setError(''); });
    void bridge.snapshot().then(receive).catch(() => { if (live) setError('本地运行服务尚未连接。'); });
    void bridge.workspaceSnapshot().then(receiveWorkspace).catch(() => {});
    return () => { live = false; off(); offWorkspace(); offOpen(); };
  }, []);
  useEffect(() => {
    let live = true;
    void bridge.workspaceShow({ visible: page === 'workspace' }).then(value => { if (live) setWorkspace(value); })
      .catch(() => { if (live) setError('工作区连接失败，请重新连接。'); });
    return () => { live = false; };
  }, [page]);
  async function action(fn: () => Promise<unknown>) {
    setError('');
    try { await fn(); } catch (e) { setError((e as Error).message); }
  }
  function navigate(next: Page) { setPage(next); setError(''); }
  function legacy(initialPage: string) { setLegacyPage(initialPage); navigate('history'); }
  const ready = workspace.phase === 'ready';
  return <div className="desktop-shell">
    <header className="shell-bar">
      <span className="shell-brand">DogO <small>狗蛋</small></span>
      <nav aria-label="DogO 导航">{[
        { id: 'workspace', label: '工作区', Icon: MessageSquare },
        { id: 'inbox', label: '资料箱', Icon: Inbox },
        { id: 'settings', label: '设置', Icon: Settings2 },
      ].map(({ id, label, Icon }) => <button key={id} className={page === id ? 'active' : ''} aria-current={page === id ? 'page' : undefined}
        onClick={() => navigate(id as Page)}><Icon size={16} />{label}</button>)}</nav>
      <div className="shell-status">
        {page === 'workspace' && <button aria-label="重新连接工作区" title="只重新加载页面，不重新执行任务" disabled={workspace.phase === 'loading' || isPreview}
          onClick={() => void action(async () => setWorkspace(await bridge.workspaceReload()))}><RefreshCw size={15} /></button>}
        <span className={state?.backend?.state === 'ready' ? 'green-dot' : 'grey-dot'} />
        <span>{state?.backend?.state === 'ready' ? '本机 DSH' : state?.backend?.state === 'starting' ? '正在启动' : '本机工作区'}</span>
        <span className="shell-relay" title="中转离线不影响本机工作区">{state?.relay?.connected ? '跨端已连接' : '跨端未连接'}</span>
      </div>
    </header>
    <div className="shell-body">
      {page === 'workspace' ? <section className="workspace-placeholder" aria-label="本机 DSH 工作区" inert={ready && !isPreview}>
        <div><MessageSquare size={32} /><h1>{isPreview ? '你的本机工作区' : ready ? 'DSH 工作区已连接' : workspace.phase === 'error' ? '工作区暂不可用' : '正在打开工作区…'}</h1>
          <p>{error || workspace.message || '直接使用内置 DSH，模型、工具和会话都留在本机。'}</p>
          {isPreview ? <p>这是网页预览；请在 DogO 桌面应用中使用完整工作区。</p> : workspace.phase === 'error' &&
            <button className="shell-primary" onClick={() => void action(async () => setWorkspace(await bridge.workspaceReload()))}>重新连接</button>}
          <button onClick={() => navigate('settings')}>查看设置</button>
        </div>
      </section> : <>
        {error && <div className="shell-error" role="alert">{error}</div>}
        {(page === 'inbox' || page === 'settings' || page === 'remote') && <HubPanel key={page} state={state} action={action}
          mode={page === 'remote' ? 'tasks' : page} onSettings={() => navigate('settings')}
          extra={page === 'settings' ? <div className="hub-card"><h3>高级与兼容入口</h3>
            <p>工作区直接使用上游 DSH 页面；这里保留 DogO 的连接参数和历史记录，不复制 DSH 插件设置。</p>
            <button onClick={() => legacy('settings')}>本地模型连接参数</button>
            <button onClick={() => navigate('remote')}>跨设备任务与离线回执</button>
            <button onClick={() => legacy('tasks')}>查看历史任务</button>
          </div> : undefined} />}
        {page === 'history' && <div className="legacy-host"><div className="legacy-return"><button onClick={() => navigate('settings')}><ArrowLeft size={15} />返回设置</button></div>
          <LegacyApp key={legacyPage} initialPage={legacyPage} /></div>}
      </>}
    </div>
  </div>;
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
