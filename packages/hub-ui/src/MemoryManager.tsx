import { useEffect, useState } from 'react';

export type MemoryCall = (input: { op: string; args?: Record<string, unknown> }) => Promise<any>;
type Editor = { path: string; content: string; base: string | null; version: number };
const empty: Editor = { path: 'preferences.md', content: '', base: null, version: 0 };

/** One editor across native folders and the browser's explicit remote-memory view. */
export function MemoryManager({ call, scope, devices = [] }: { call: MemoryCall; scope: string; devices?: { id: string; name: string }[] }) {
  const key = 'dogo.memory.editor.' + scope;
  const [editor, setEditor] = useState<Editor>(() => { try { return JSON.parse(localStorage.getItem(key) || 'null') ?? empty; } catch { return empty; } });
  const [state, setState] = useState<any>({ files: [], enabled: false });
  const [files, setFiles] = useState<string[]>([]), [versions, setVersions] = useState<any[]>([]), [conflicts, setConflicts] = useState<any[]>([]);
  const [beforeVersion, setBeforeVersion] = useState<number | null>(null);
  const [policy, setPolicy] = useState<any>(null), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false), [target, setTarget] = useState('');
  useEffect(() => { try { localStorage.setItem(key, JSON.stringify(editor)); } catch { setNotice('编辑草稿未能保存到本机，请勿关闭页面'); } }, [key, editor]);
  const refresh = async () => {
    const s = await call({ op: 'status' }); setState(s); let cloud: string[] = [];
    try { cloud = (await call({ op: 'list' })).files.map((f: any) => f.path); } catch { /* Local edits remain available offline. */ }
    setFiles([...new Set([...s.files, ...cloud])].sort());
  };
  useEffect(() => { void refresh().catch(e => setNotice(e.message)); }, [call]);
  const run = async (fn: () => Promise<void>) => { if (busy) return; setBusy(true); setNotice(''); try { await fn(); await refresh(); } catch (e) { setNotice((e as Error).message); } finally { setBusy(false); } };
  const read = async (path: string) => { const r = await call({ op: 'read', args: { path } }); setEditor({ path, content: r.content ?? '', base: r.content, version: r.version ?? 0 }); setVersions([]); setBeforeVersion(null); };
  const dirty = editor.content !== (editor.base ?? '');
  const switchFile = (path: string) => { if (dirty && !confirm('替换当前未保存的编辑草稿？')) return; void run(() => read(path)); };
  const save = async (content: string | null) => {
    await call({ op: 'write', args: { ...editor, content } });
    setEditor(e => ({ ...e, base: content, content: content ?? '' }));
    if (state.enabled && !state.remote) await call({ op: 'sync' });
    await read(editor.path); setNotice(content === null ? '已删除；同步端会收到删除标记，历史仍可恢复' : '已保存；并发变化会保留为冲突');
  };
  return <section className="hub-card"><h3>个人记忆</h3><p>{state.remote ? '网页直接读写服务器上的个人记忆。' : '只同步 DogO 专用文件夹。'}项目、聊天和资料箱不自动成为记忆；不要写入密码或 API key。</p>
    {!state.remote && <label><span><input type="checkbox" style={{ width: 'auto' }} disabled={busy} checked={state.enabled} onChange={e => void run(async () => { await call({ op: 'configure', args: { enabled: e.target.checked } }); })} /> 开启专用目录同步</span></label>}
    <button disabled={busy || (!state.remote && !state.enabled)} onClick={() => void run(async () => { await call({ op: 'sync' }); setNotice(state.remote ? '已刷新服务器内容' : '同步完成；请留意下方待处理冲突'); })}>{state.remote ? '刷新' : '立即同步'}</button>
    <button disabled={busy} onClick={() => void run(async () => {
      const value = await call({ op: 'export' });
      if (value.files) { const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' })); const a = document.createElement('a'); a.href = url; a.download = 'dogo-personal-memory.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 30000); }
      setNotice(value.saved === false ? '导出已取消' : '已导出当前个人记忆；导出文件含个人信息，请妥善保管');
    })}>导出当前文件</button>
    <details><summary>编辑与历史恢复</summary>
      <label>文件（包含服务器已删除文件）<select disabled={busy} value={files.includes(editor.path) ? editor.path : ''} onChange={e => switchFile(e.target.value)}><option value="" disabled>新文件</option>{files.map(p => <option key={p}>{p}</option>)}</select></label>
      <label>文件名<input value={editor.path} disabled={busy} onChange={e => { setEditor(v => ({ ...v, path: e.target.value, base: null, version: 0 })); setVersions([]); setBeforeVersion(null); }} /></label>
      <label>内容<textarea rows={8} maxLength={256000} disabled={busy} value={editor.content} onChange={e => setEditor(v => ({ ...v, content: e.target.value }))} /></label>
      <button disabled={busy} onClick={() => void run(() => save(editor.content))}>保存{state.enabled && !state.remote ? '并同步' : ''}</button>
      <button disabled={busy} onClick={() => switchFile(editor.path)}>重新读取</button>
      <button disabled={busy || editor.base === null} onClick={() => { if (confirm(`删除 ${editor.path}？同步后其他设备也会删除；历史版本保留。`)) void run(() => save(null)); }}>删除</button>
      <label>重命名为<input disabled={busy} value={target} onChange={e => setTarget(e.target.value)} /></label>
      <button disabled={busy || !target || dirty} onClick={() => void run(async () => { await call({ op: 'rename', args: { ...editor, target } }); if (state.enabled && !state.remote) await call({ op: 'sync' }); await read(target); setTarget(''); })}>重命名（先保存编辑）</button>
      <button disabled={busy} onClick={() => void run(async () => { const result = await call({ op: 'versions', args: { path: editor.path } }); setVersions(result.versions); setBeforeVersion(result.nextBefore); })}>查看服务器历史</button>
      {versions.map(v => <details key={v.version}><summary>版本 {v.version} · {new Date(v.updatedAt).toLocaleString()} · {v.content === null ? '删除' : v.updatedBy}</summary><pre>{v.content ?? '删除标记'}</pre>
        <button disabled={busy} onClick={() => { if (confirm('将此历史版本载入编辑器？不会立即覆盖当前文件，确认内容后再点保存。')) setEditor(e => ({ ...e, content: v.content ?? '' })); }}>载入为待保存草稿</button></details>)}
      {beforeVersion != null && <button disabled={busy} onClick={() => void run(async () => { const result = await call({ op: 'versions', args: { path: editor.path, before: beforeVersion } }); setVersions(items => [...items, ...result.versions]); setBeforeVersion(result.nextBefore); })}>加载更早历史（每页 10 个）</button>}
    </details>
    <details><summary>冲突与维护 Agent</summary>
      <button disabled={busy} onClick={() => void run(async () => { setConflicts((await call({ op: 'conflicts' })).conflicts.filter((c: any) => c.status !== 'resolved')); setPolicy(await call({ op: 'policy' })); })}>刷新冲突和维护配置</button>
      {policy && <div><label><span><input type="checkbox" style={{ width: 'auto' }} checked={policy.automatic} onChange={e => setPolicy({ ...policy, automatic: e.target.checked })} /> 允许独立 Agent 尝试一次合并，失败转人工</span></label>
        <p>选择设备不等于启用执行：桌面须开启无人值守；手机须在模型设置允许记忆维护，并保持应用前台运行。</p>
        {(['primary', 'backup'] as const).map(k => <label key={k}>{k === 'primary' ? '优先维护端' : '优先端离线时的备用端'}<select value={policy[k] ?? ''} onChange={e => setPolicy({ ...policy, [k]: e.target.value || null })}><option value="">{k === 'primary' ? '任一在线且获准的维护 Agent' : '不指定'}</option>{(policy.devices ?? devices).map((d: { id: string; name: string }) => <option value={d.id} key={d.id}>{devices.find(v => v.id === d.id)?.name ?? d.name}</option>)}</select></label>)}
        <button disabled={busy} onClick={() => void run(async () => { const { primary, backup, automatic } = policy; setPolicy(await call({ op: 'configurePolicy', args: { primary, backup, automatic } })); setNotice('已更新维护策略；未能解决的冲突保留供人工处理'); })}>保存维护策略</button></div>}
      {conflicts.map(c => <MemoryConflict key={c.id} value={c} disabled={busy} resolve={content => void run(async () => { await call({ op: 'resolve', args: { id: c.id, version: c.remoteVersion, content, reason: '用户在 DogO 确认处理' } }); if (state.enabled && !state.remote) await call({ op: 'sync' }); setConflicts(items => items.filter(i => i.id !== c.id)); setNotice('冲突已处理，双方历史保留'); })} />)}
    </details>{notice && <p role="status">{notice}</p>}{busy && <p role="status">处理中，请勿重复提交…</p>}
  </section>;
}
function MemoryConflict({ value, disabled, resolve }: { value: any; disabled: boolean; resolve(content: string | null): void }) {
  const [text, setText] = useState(value.remote ?? '');
  return <article><h4>{value.path} · {value.status}</h4><p>{value.reason}</p><details><summary>基准 / 本端 / 服务器版本</summary><pre>{JSON.stringify({ base: value.base, local: value.local, remote: value.remote }, null, 2)}</pre></details>
    <textarea rows={6} value={text} disabled={disabled} onChange={e => setText(e.target.value)} />
    <button disabled={disabled} onClick={() => resolve(text)}>确认合并内容</button><button disabled={disabled} onClick={() => { if (confirm('确认以删除解决冲突？历史仍保留。')) resolve(null); }}>确认删除</button></article>;
}
