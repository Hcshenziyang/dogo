import { useEffect, useState } from 'react';
import { HubRelay, native } from './platform';

export function MemorySettings() {
  const [state, setState] = useState<{ enabled: boolean; files: string[]; at: number }>({ enabled: false, files: [], at: 0 });
  const [path, setPath] = useState('preferences.md');
  const [content, setContent] = useState('');
  const [conflicts, setConflicts] = useState<any[]>([]);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const refresh = async () => { setState(await HubRelay.memory({ op: 'status' })); };
  useEffect(() => { if (native) void refresh().catch(e => setNotice(e.message)); }, []);
  const run = async (fn: () => Promise<unknown>) => { setBusy(true); setNotice(''); try { await fn(); await refresh(); } catch (e) { setNotice((e as Error).message); } finally { setBusy(false); } };
  return <section className="hub-card"><h3>个人记忆同步</h3><p>只同步 DogO 专用个人记忆文件夹；项目记忆、聊天、资料箱和凭据不混入。当前支持 md / txt / json。</p>
    <label><span><input style={{ width: 'auto' }} type="checkbox" disabled={!native || busy} checked={state.enabled} onChange={e => run(() => HubRelay.memory({ op: 'configure', args: { enabled: e.target.checked } }))} /> 开启专用文件夹同步</span></label>
    <button disabled={!native || busy || !state.enabled} onClick={() => run(async () => { const r = await HubRelay.memory({ op: 'sync' }); setNotice(`同步完成 · ${r.changes} 项变化 · ${r.conflicts} 项待处理`); })}>立即同步</button>
    <small>上次同步：{state.at ? new Date(state.at).toLocaleString('zh-CN') : '尚未同步'}</small>
    <details><summary>查看与编辑个人记忆</summary><p>文件名使用小写英文或数字。不保存密码、API key。</p>
      <label>现有文件<select value={state.files.includes(path) ? path : ''} onChange={e => run(async () => { setPath(e.target.value); setContent((await HubRelay.memory({ op: 'read', args: { path: e.target.value } })).content); })}><option value="">新文件</option>{state.files.map(p => <option key={p}>{p}</option>)}</select></label>
      <label>文件名<input value={path} onChange={e => setPath(e.target.value)} /></label><label>内容<textarea rows={7} maxLength={256000} value={content} onChange={e => setContent(e.target.value)} /></label>
      <button disabled={!native || busy} onClick={() => run(async () => { await HubRelay.memory({ op: 'write', args: { path, content } }); setNotice('已保存本机'); if (state.enabled) { await HubRelay.memory({ op: 'sync' }); setNotice('已保存并同步；冲突版本将保留'); } })}>保存{state.enabled ? '并同步' : '到本机'}</button>
    </details>
    <details><summary onClick={() => { if (native) void HubRelay.memory({ op: 'conflicts' }).then(r => setConflicts(r.conflicts.filter((c: any) => c.status !== 'resolved'))).catch(e => setNotice(e.message)); }}>需要处理的冲突</summary>
      {conflicts.map(c => <Conflict key={c.id} value={c} disabled={busy} resolve={text => run(async () => { await HubRelay.memory({ op: 'resolve', args: { id: c.id, version: c.remoteVersion, content: text, reason: '用户在手机确认合并' } }); setConflicts(conflicts.filter(i => i.id !== c.id)); await HubRelay.memory({ op: 'sync' }); })} />)}
      {!conflicts.length && <p>当前没有待处理冲突。</p>}
    </details>{notice && <p role="status">{notice}</p>}
  </section>;
}
function Conflict({ value, disabled, resolve }: { value: any; disabled: boolean; resolve(content: string): void }) {
  const [candidate, setCandidate] = useState(value.remote ?? '');
  return <div><h4>{value.path} · {value.status === 'needs-human' ? '需要人工' : value.status === 'analyzing' ? 'Agent 分析中' : '等待 Agent'}</h4><p>{value.reason}</p><details><summary>基准 / 本端 / 服务器版本</summary><pre>{JSON.stringify({ base: value.base, local: value.local, remote: value.remote }, null, 2)}</pre></details><label>人工合并后的完整内容<textarea value={candidate} onChange={e => setCandidate(e.target.value)} rows={6} /></label><button disabled={disabled} onClick={() => resolve(candidate)}>确认合并，保留历史版本</button></div>;
}
