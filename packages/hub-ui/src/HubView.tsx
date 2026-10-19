import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import { Inbox, MessageSquare, Settings2, RefreshCw, ArrowLeft, Send, Plus, Paperclip, X, CircleCheck } from 'lucide-react';
import { HubSession, type HubItem } from './client';
import './style.css';

const time = (value?: number | null) => value ? new Date(value).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '尚未同步';
const labels: Record<string, string> = { queued: '等待设备执行', running: '正在执行', succeeded: '已完成', failed: '执行失败', interrupted: '执行中断 · 未重跑', cancelled: '已停止', saved: '服务器已保存', received: '电脑已接收', read: '已读', processed: '已处理', archived: '已归档', idle: '可继续', waiting: '等待你回复', unavailable: '原会话不可用' };

export function HubView({ client, settings, assistant, onBack, desktop = false, registerBack, initialTab = 'tasks', embedded = false, onSettings }: {
  client: HubSession; settings?: ReactNode; assistant?: ReactNode; onBack?: () => void; desktop?: boolean;
  initialTab?: 'tasks' | 'inbox' | 'settings'; embedded?: boolean; onSettings?: () => void;
  registerBack?: (handler: () => void) => Promise<{ remove(): Promise<void> }>;
}) {
  const state = useSyncExternalStore(client.subscribe, client.snapshot);
  const [tab, setTab] = useState<'tasks' | 'inbox' | 'settings' | 'assistant'>(initialTab);
  const [selected, setSelected] = useState<string>();
  const [compose, setCompose] = useState(false);
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const attachments = state.draft.attachments ?? [];
  const followup = selected ? state.replies[selected] ?? '' : '';
  const replyFiles = selected ? state.replyFiles[selected] ?? [] : [];
  const setFollowup = (text: string) => { if (selected) void client.reply(selected, text).catch(e => setError(e.message)); };
  const setAttachments = (value: NonNullable<HubItem['attachments']>) => void client.draft({ attachments: value }).catch(e => setError(e.message));
  const [query, setQuery] = useState('');
  const back = useRef(() => {});
  back.current = () => { if (compose) setCompose(false); else if (selected) setSelected(undefined); else if (tab !== 'tasks') setTab('tasks'); else onBack?.(); };
  useEffect(() => { if (!registerBack) return; const h = registerBack(() => back.current()); return () => { void h.then(v => v.remove()); }; }, [registerBack]);
  useEffect(() => {
    void client.refresh();
    let last = 0;
    const poll = () => { const active = client.snapshot().items.some(i => i.type === 'command' && i.status === 'running');
      if (!document.hidden && (active || Date.now() - last > 6000)) { last = Date.now(); void client.refresh(); } };
    const timer = setInterval(poll, 1000); document.addEventListener('visibilitychange', poll);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', poll); };
  }, [client]);
  useEffect(() => {
    if (!selected || !state.items.some(i => i.id === selected && i.type === 'session')) return;
    void client.history(selected).catch(e => setError(e.message));
  }, [client, selected, state.syncedAt]);
  const item = state.items.find(i => i.id === selected);
  const sessions = state.items.filter(i => i.type === 'session' && (i.title ?? '').toLowerCase().includes(query.toLowerCase())).sort((a, b) => b.updatedAt - a.updatedAt);
  const notes = state.items.filter(i => i.type === 'note' && `${i.title} ${i.text}`.toLowerCase().includes(query.toLowerCase())).sort((a, b) => b.updatedAt - a.updatedAt);
  const devices = state.items.filter(i => i.type === 'device');
  const projects = state.items.filter(i => i.type === 'project' && i.owner === state.draft.target);
  const pending = state.items.filter(i => i.type === 'request' && i.state === 'pending' && !i.answer);
  const commands = state.items.filter(i => i.type === 'command' && i.sessionId === selected).sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
  const action = async (fn: () => Promise<unknown>) => { if (sending) return; setSending(true); setError(''); try { await fn(); } catch (e) { setError((e as Error).message); } finally { setSending(false); } };
  const draft = (patch: Partial<typeof state.draft>) => void client.draft(patch).catch(e => setError(e.message));
  const open = (id: string) => { setSelected(id); setError('');
    const note = state.items.find(i => i.type === 'note' && i.id === id);
    if (note && ['saved', 'received'].includes(note.state ?? '')) void client.send('noteState', { id, state: 'read' }).catch(e => setError(e.message));
  };
  const doSend = () => action(async () => {
    if (!state.draft.text.trim()) throw new Error('请填写内容');
    await client.send(state.draft.kind === 'note' ? 'note' : 'create', { target: state.draft.target, projectId: state.draft.projectId || null,
      title: state.draft.title.trim() || state.draft.text.slice(0, 60), attachments, artifactIds: state.draft.artifactIds ?? [],
      ...(state.draft.kind === 'note' ? { text: state.draft.text } : { prompt: state.draft.text, ...(state.draft.sourceNoteId ? { sourceNoteId: state.draft.sourceNoteId } : {}) }) });
    await client.draft({ title: '', text: '', attachments: [], artifactIds: [], sourceNoteId: undefined }); setCompose(false);
  });
  const attach = async (files: FileList | null, reply = false) => {
    if (!files) return;
    try {
      const next = [...(reply ? replyFiles : attachments)];
      for (const file of Array.from(files)) {
        if (next.length >= 4 || file.size + next.reduce((n, a) => n + Math.ceil(a.data.length * 3 / 4), 0) > 8 * 1024 * 1024) throw new Error('每轮最多 4 个附件，总计不超过 8 MiB');
        const data = await new Promise<string>((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(String(r.result).split(',')[1]); r.onerror = reject; r.readAsDataURL(file); });
        next.push({ name: file.name, mime: file.type || 'application/octet-stream', data });
      }
      if (reply && selected) await client.replyAttachments(selected, next); else setAttachments(next);
    } catch (e) { setError((e as Error).message); }
  };
  return <div className={`hub-shell ${desktop ? 'hub-desktop' : ''}`}>
    <header className="hub-header">{!embedded ? <div className="hub-logo">D<span>ogO</span><small>狗蛋 · 随时接着做</small></div> : <span>跨设备{initialTab === 'inbox' ? '资料箱' : initialTab === 'settings' ? '设置' : '回执'} · {state.configured ? '已配对' : '未配对'}</span>}
      <button aria-label="刷新" onClick={() => void client.refresh()} disabled={state.busy}><RefreshCw size={19} className={state.busy ? 'hub-spin' : ''} /></button></header>
    <main className="hub-main">
      {(error || state.error) && <div className="hub-alert" role="alert">{error || state.error}<button onClick={() => void client.refresh()}>重试</button></div>}
      {!state.configured && (!embedded || tab !== 'settings') && <div className="hub-card"><h2>连接你的设备</h2><p>在设置中登录个人账号。任务由原设备执行，记录只进入资料箱。</p><button className="hub-primary" onClick={() => onSettings ? onSettings() : setTab('settings')}>打开设置</button></div>}
      {compose ? <section className="hub-card hub-compose"><button className="hub-text" onClick={() => setCompose(false)}><ArrowLeft size={17} /> 返回</button><h1>发送到你的电脑</h1>
        <div className="hub-segment"><button className={state.draft.kind === 'task' ? 'active' : ''} onClick={() => draft({ kind: 'task' })}>执行任务</button><button className={state.draft.kind === 'note' ? 'active' : ''} onClick={() => draft({ kind: 'note' })}>存入资料箱</button></div>
        <p>{state.draft.kind === 'task' ? '发送后按电脑的预授权自动执行，无需电脑端再次点击。' : '只保存内容，不调用 Agent，也不写入项目文件。'}</p>
        <label>设备<select value={state.draft.target} onChange={e => draft({ target: e.target.value, projectId: '' })}>{devices.length ? devices.map(d => <option value={d.owner} key={d.id}>{d.name} · {d.online ? '在线' : '离线，服务器暂存'}</option>) : <option value="mac">Mac · 等待连接</option>}</select></label>
        <label>项目<select value={state.draft.projectId} onChange={e => draft({ projectId: e.target.value })}><option value="">不指定项目</option>{projects.map(p => <option value={p.id} key={p.id} disabled={!p.available}>{p.name}{p.available ? '' : ' · 不可用'}</option>)}</select></label>
        {state.draft.projectId && <p className="hub-muted">{projects.find(p => p.id === state.draft.projectId)?.summary || '暂无简介'} · 信息更新 {time(projects.find(p => p.id === state.draft.projectId)?.updatedAt)}</p>}
        <label>标题（可选）<input maxLength={300} value={state.draft.title} onChange={e => draft({ title: e.target.value })} /></label>
        <label>内容<textarea rows={7} maxLength={64000} value={state.draft.text} onChange={e => draft({ text: e.target.value })} placeholder={state.draft.kind === 'task' ? '需要电脑帮你完成什么？' : '记下想法，或附上一份资料…'} /></label>
        <label className="hub-file"><Paperclip size={16} />添加附件（最多 4 个 / 总计 8 MiB）<input type="file" multiple onChange={e => void attach(e.target.files)} /></label>{attachments.map((a, index) => <p key={index}>{a.name}<button aria-label="移除附件" onClick={() => setAttachments(attachments.filter((_, n) => index !== n))}><X size={14} /></button></p>)}
        {state.draft.sourceNoteId && <p>来自资料箱；发送后与原记录关联，原附件会一并保留。</p>}
        <button className="hub-primary" disabled={sending || !state.configured || !state.draft.text.trim()} onClick={doSend}><Send size={17} />{sending ? '正在保存…' : state.draft.kind === 'task' ? '发送并执行' : '保存资料'}</button>
      </section> : item ? <section><button className="hub-text" onClick={() => setSelected(undefined)}><ArrowLeft size={17} /> 返回列表</button><h1>{item.title}</h1><p className="hub-muted">{item.owner} · {labels[item.state ?? ''] || item.state} · 同步 {time(item.updatedAt)}</p>
        {item.type === 'note' ? <div className="hub-card"><pre>{item.text}</pre>{item.attachments?.map((a, n) => <details key={n}><summary><Paperclip size={16} /> {a.name}</summary>{['image/png', 'image/jpeg', 'image/webp'].includes(a.mime) ? <img alt={a.name} src={`data:${a.mime};base64,${a.data}`} /> : a.mime.startsWith('text/') ? <pre>{new TextDecoder().decode(Uint8Array.from(atob(a.data), c => c.charCodeAt(0)))}</pre> : <p>附件已保存在服务器和接收端资料箱。</p>}</details>)}
          {item.receivedAt !== undefined && <p className="hub-muted">{item.receivedAt ? `原设备收到：${time(item.receivedAt)}` : '服务器已保存，等待原设备完整收件'}{item.readAt ? ` · 阅读：${time(item.readAt)}` : ''}</p>}
          {item.artifactIds?.map(id => <ArtifactCard key={id} id={id} client={client} />)}
          {!['processed', 'archived'].includes(item.state ?? '') && <button onClick={() => action(() => client.send('noteState', { id: item.id, state: 'processed' }))}><CircleCheck size={16} />标记已处理</button>}
          {item.state !== 'archived' && <button onClick={() => action(() => client.send('noteState', { id: item.id, state: 'archived' }))}>归档（保留内容）</button>}
          {item.linkedSessions?.map(id => <button key={id} onClick={() => open(id)}>查看关联任务 →</button>)}
          <button onClick={() => { draft({ kind: 'task', title: item.title ?? '', text: item.text ?? '', target: item.owner, projectId: item.projectId ?? '', attachments: item.attachments ?? [], artifactIds: item.artifactIds ?? [], sourceNoteId: item.id }); setSelected(undefined); setCompose(true); }}>转为任务（保留原记录和附件）</button></div>
        : <>
          {item.sourceNoteId && <button onClick={() => open(item.sourceNoteId!)}>← 查看来源资料</button>}
          {pending.filter(r => r.sessionId === item.id).map(r => <RequestCard key={r.id} item={r} disabled={sending} answer={value => action(() => client.send('answer', { id: r.id, answer: value }))} />)}
          {(state.history[item.id] ?? []).map(m => m.hasDetails ? <ToolDetails key={m.id} client={client} sessionId={item.id} message={m} /> : <article className={`hub-message hub-${m.role}`} key={m.id}><small>{m.role === 'user' ? '你' : 'DogO'} · {time(m.at)}</small><pre>{m.text}</pre></article>)}
          {commands.map(c => <details className="hub-card hub-turn" key={c.id} open={c.status !== 'succeeded'}><summary>{labels[c.status ?? ''] || c.status} · {time(c.createdAt)}{c.stopRequested && c.status === 'running' ? ' · 正在请求停止' : ''}</summary><p>{c.prompt}</p>{c.artifactIds?.map(id => <ArtifactCard key={id} id={id} client={client} />)}{c.result && <pre>{c.result}</pre>}{['queued', 'running'].includes(c.status ?? '') && <button disabled={sending || c.stopRequested} onClick={() => action(() => client.send('stop', { id: c.id }))}>停止本轮</button>}</details>)}
          {item.readOnly ? <p className="hub-muted">这是保留的只读测试会话，不能在手机扩大权限；可新建正常会话。</p> : <form className="hub-reply" onSubmit={e => { e.preventDefault(); void action(async () => { if (!followup.trim()) return; await client.send('send', { sessionId: item.id, prompt: followup, attachments: replyFiles }); setFollowup(''); await client.replyAttachments(item.id, []); }); }}><textarea aria-label="继续原会话" value={followup} onChange={e => setFollowup(e.target.value)} placeholder="继续这项任务，仍由原设备处理…" maxLength={64000} rows={3} /><label className="hub-file">续聊附件<input type="file" multiple onChange={e => void attach(e.target.files, true)} /></label>{replyFiles.map((a, index) => <p key={index}>{a.name}<button type="button" onClick={() => void client.replyAttachments(item.id, replyFiles.filter((_, n) => n !== index))}>移除</button></p>)}<button className="hub-primary" disabled={sending || !followup.trim()}><Send size={17} />发送</button></form>}
          <details className="hub-identity"><summary>原会话标识</summary><p>设备：{item.owner}<br />DSH：{item.nativeId}<br />实例：{item.instance}</p></details>
        </>}
      </section> : tab === 'assistant' ? assistant : tab === 'settings' ? <section><h1>设置</h1><p className="hub-muted">连接、通知与同步放在这里。</p>{settings}<div className="hub-card"><h3>设备与项目</h3>{devices.map(d => <details key={d.id}><summary>{d.name} · {d.online ? '在线' : '离线'} · {d.ready ? 'DSH 就绪' : '执行器未就绪'}{d.autoExecute === false ? ' · 接单暂停' : ''}</summary>{d.readiness?.checks.map(c => <p key={c.id}>{c.ok ? '✓' : '待处理'} · {c.message}</p>)}<small>准备检查 {time(d.readiness?.at)}</small></details>)}{state.items.filter(i => i.type === 'project').map(p => <p key={p.id}>{p.name} · {p.owner} · {p.available ? '可用' : '不可用'}</p>)}<p>刷新 {time(state.syncedAt)}</p></div>{onBack && <button onClick={onBack}>旧版任务与演示记录</button>}</section>
      : <section><div className="hub-heading"><div><h1>{tab === 'tasks' ? '接着上次的事。' : '先记下来。'}</h1><p>{tab === 'tasks' ? '电脑负责执行，你随时回来看看。' : '你的资料箱，不会自动触发任务。'}</p></div><button className="hub-primary" aria-label="新建" onClick={() => { draft({ kind: tab === 'tasks' ? 'task' : 'note' }); setCompose(true); }}><Plus size={20} /></button></div>
        {pending.length > 0 && <button className="hub-alert" onClick={() => open(pending[0].sessionId!)}>{pending.length} 项需要你回复 →</button>}
        {state.outbox.map(p => <div className="hub-card" key={p.id}><strong>待发送／等待确认</strong><p>{String(p.args.title ?? p.args.prompt ?? '操作请求').slice(0, 200)}</p><small>{p.error || '保留在本机，联网后按原请求编号重试'}</small></div>)}
        <input className="hub-search" aria-label="搜索" placeholder={tab === 'tasks' ? '搜索会话' : '搜索资料'} value={query} onChange={e => setQuery(e.target.value)} />
        {(tab === 'tasks' ? sessions : notes).map(row => { const command = state.items.filter(i => i.type === 'command' && i.sessionId === row.id).sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))[0]; return <button className="hub-list-item" key={row.id} onClick={() => open(row.id)}><span className="hub-item-icon">{tab === 'tasks' ? <MessageSquare size={20} /> : <Inbox size={20} />}</span><span><strong>{row.title}</strong><small>{row.owner} · {labels[command?.status ?? row.state ?? ''] || '已同步'} · {time(row.updatedAt)}</small></span><span>›</span></button>; })}
        {!(tab === 'tasks' ? sessions : notes).length && <div className="hub-empty"><Inbox size={36} /><h3>{tab === 'tasks' ? '还没有会话' : '资料箱是空的'}</h3><p>{tab === 'tasks' ? '发送第一个任务，或刷新电脑上的 DSH 会话。' : '文字和附件都可以先存到这里。'}</p></div>}
        <p className="hub-muted">同步 {time(state.syncedAt)} · 离线时显示已保存内容</p>
      </section>}
    </main>
    {!embedded && !compose && !selected && <nav className="hub-nav">{assistant && <button className={tab === 'assistant' ? 'active' : ''} onClick={() => setTab('assistant')}><MessageSquare size={20} />对话</button>}{([{ id: 'tasks', label: '任务', Icon: MessageSquare }, { id: 'inbox', label: '资料箱', Icon: Inbox }, { id: 'settings', label: '设置', Icon: Settings2 }] as const).map(({ id, label, Icon }) => <button key={id} className={tab === id ? 'active' : ''} onClick={() => { setTab(id); setQuery(''); }}><Icon size={20} />{label}</button>)}</nav>}
  </div>;
}

function ToolDetails({ client, sessionId, message }: { client: HubSession; sessionId: string; message: import('./client').Message }) {
  const [detail, setDetail] = useState(''), [error, setError] = useState('');
  return <details className="hub-card" onToggle={event => { if (event.currentTarget.open && !detail) void client.details(sessionId, message.id).then(value => setDetail(value.detail + (value.truncated ? '\n[较长日志仅显示前 64000 字符，完整记录在原 DSH 会话。]' : ''))).catch(e => setError(e.message)); }}>
    <summary>{message.text} · {time(message.at)}</summary><pre>{detail || error || '正在按需读取工具记录…'}</pre>
  </details>;
}

function ArtifactCard({ client, id }: { client: HubSession; id: string }) {
  const [meta, setMeta] = useState<any>(), [text, setText] = useState(''), [preview, setPreview] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  useEffect(() => { void client.artifactMetadata(id).then(setMeta).catch(e => setError(e.message)); }, [client, id]);
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);
  async function read() {
    setBusy(true); setError('');
    try {
      const file = await client.artifact(id);
      if (['image/png', 'image/jpeg', 'image/webp'].includes(file.mime)) setPreview(URL.createObjectURL(new Blob([file.bytes], { type: file.mime })));
      else if (file.mime.startsWith('text/') || file.mime === 'application/json') setText(new TextDecoder().decode(file.bytes).slice(0, 256000));
      else setError('此格式不内嵌预览，请另存后用对应应用打开');
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  return <details className="hub-card"><summary><Paperclip size={16} /> {meta?.name ?? '附件'}{meta ? ` · ${(meta.size / 1024).toFixed(1)} KiB` : ''}</summary><p>联网按需读取；另存后可离线查看。不会自动执行文件。</p>
    <button disabled={busy || !meta} onClick={() => void read()}>预览</button><button disabled={busy || !meta} onClick={async () => { setBusy(true); try { await client.saveArtifact(id, meta.name); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }}>另存附件</button>
    {preview && <img src={preview} alt={meta?.name} />}{text && <pre>{text}</pre>}{error && <p role="alert">{error}</p>}
  </details>;
}

function RequestCard({ item, answer, disabled }: { item: HubItem; answer(value: string): void; disabled: boolean }) {
  const [values, setValues] = useState<Record<string, string>>({});
  return <section className="hub-card hub-request"><h3>{item.title}</h3><pre>{item.details}</pre>{item.kind === 'approval' ? <div className="hub-actions"><button className="hub-primary" disabled={disabled} onClick={() => answer('allow')}>仅允许这一次</button><button disabled={disabled} onClick={() => answer('reject')}>拒绝</button></div> : <>{item.questions?.map(q => <label key={q.id}>{q.question}{q.options.length > 0 && <small>{q.options.join(' / ')}</small>}<input value={values[q.id] ?? ''} onChange={e => setValues({ ...values, [q.id]: e.target.value })} /></label>)}<button className="hub-primary" disabled={disabled || item.questions?.some(q => !values[q.id]?.trim())} onClick={() => answer(JSON.stringify({ answers: item.questions?.map(q => ({ id: q.id, selected: [], custom: values[q.id] })) }))}>回复并继续</button></>}</section>;
}
