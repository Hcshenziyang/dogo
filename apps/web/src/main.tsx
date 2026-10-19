import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MessageSquare, RefreshCw } from 'lucide-react';
import { bridge, isPreview, type Snapshot, type WorkspaceViewState } from './bridge';
import './style.css';
import './workspace.css';

// The shell owns window lifecycle only. Product pages are DSH Client plugins.
function App() {
  const [state, setState] = useState<Snapshot>();
  const [workspace, setWorkspace] = useState<WorkspaceViewState>({ phase: 'idle', message: '', visible: true });
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    const receive = (value: Snapshot) => { if (live) setState(value); };
    const receiveWorkspace = (value: WorkspaceViewState) => { if (live) setWorkspace(value); };
    const off = bridge.subscribe(receive), offWorkspace = bridge.onWorkspace(receiveWorkspace);
    const offOpen = bridge.onOpenWorkspace(() => { void bridge.workspaceShow({ visible: true }).then(receiveWorkspace); });
    void bridge.snapshot().then(receive).catch(() => { if (live) setError('DSH 尚未连接。'); });
    void bridge.workspaceShow({ visible: true }).then(receiveWorkspace).catch(() => { if (live) setError('工作区连接失败，请重新连接。'); });
    return () => { live = false; off(); offWorkspace(); offOpen(); };
  }, []);
  async function reload() {
    setError('');
    try { setWorkspace(await bridge.workspaceReload()); } catch (e) { setError((e as Error).message); }
  }
  const ready = workspace.phase === 'ready';
  return <div className="desktop-shell">
    <header className="shell-bar"><span className="shell-brand">DogO <small>狗蛋</small></span>
      <div className="shell-status">
        <button aria-label="重新连接工作区" title="重新加载工作区" disabled={workspace.phase === 'loading' || isPreview} onClick={() => void reload()}><RefreshCw size={15} /></button>
        <span className={state?.backend?.state === 'ready' ? 'green-dot' : 'grey-dot'} />
        <span>{ready ? '本机 DSH' : '正在连接工作区'}</span>
        <span className="shell-relay">{state?.relay?.connected ? '跨端已连接' : '跨端未连接'}</span>
      </div>
    </header>
    <div className="shell-body"><section className="workspace-placeholder" aria-label="本机 DSH 工作区" inert={ready && !isPreview}>
      <div><MessageSquare size={32} /><h1>{isPreview ? '你的本机工作区' : ready ? 'DSH 工作区已连接' : workspace.phase === 'error' ? '工作区暂不可用' : '正在打开工作区…'}</h1>
        <p>{error || workspace.message || '会话、资料、记忆和设置都在工作区中。'}</p>
        {isPreview ? <p>请在 DogO 桌面应用中打开工作区。</p> : workspace.phase === 'error' && <button className="shell-primary" onClick={() => void reload()}>重新连接</button>}
      </div>
    </section></div>
  </div>;
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
