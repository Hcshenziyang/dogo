import { useEffect, useState, useSyncExternalStore } from 'react';
import { mobileAgent, agentTransport, phoneMaintenance } from './agent-platform';
import type { AgentConfigInput } from './agent';

export function AgentView() {
  const state = useSyncExternalStore(mobileAgent.subscribe, mobileAgent.snapshot);
  const [error, setError] = useState(''), [draft, setDraft] = useState('');
  const chat = state.chats.find(c => c.id === state.selected);
  const busy = state.chats.some(c => c.state === 'running');
  useEffect(() => { void mobileAgent.load().catch(e => setError(e.message)); }, []);
  useEffect(() => { setDraft(chat?.draft ?? ''); }, [chat?.id]);
  const action = async (work: () => Promise<unknown>) => { try { setError(''); await work(); } catch (e) { setError((e as Error).message); } };
  const labels = { idle: '本轮已结束', running: '手机正在执行', interrupted: '已中断 · 未重试', failed: '执行失败', limited: '达到本轮限制 · 可续聊' };
  return <section className="phone-agent">
    <div className="hub-heading"><div><h1>随身聊一聊。</h1><p>手机独立执行 · 不需要 Mac 在线</p></div><button disabled={busy || !state.loaded} onClick={() => void action(() => mobileAgent.create())}>新对话</button></div>
    <p className="hub-muted">先在设置填写模型 API。手机本轮最多 8 步、5 分钟、每步输出 4096 tokens；切到后台会停止本机执行，桌面任务不受影响。历史自动压缩，原文保留。</p>
    {(error || state.error) && <p role="alert">{error || state.error}</p>}
    {state.chats.length > 0 && <label>手机会话<select aria-label="手机会话" value={state.selected} onChange={e => void action(() => mobileAgent.select(e.target.value))}>{state.chats.map(c => <option key={c.id} value={c.id}>{c.title} · {labels[c.state]}</option>)}</select></label>}
    {!chat && <div className="hub-empty"><h3>这是手机自己的对话</h3><p>需要电脑工作时，可让它明确委派任务；也可以直接使用“任务”页面。</p></div>}
    {chat && <>
      <p>{labels[chat.state]} <button disabled={busy} onClick={() => void action(async () => { await mobileAgent.flush(); await agentTransport.exportHistory(); })}>导出完整历史</button><button disabled={busy} onClick={() => { if (confirm('永久删除此手机对话？建议先导出历史。不会删除桌面任务或记忆。')) void action(() => mobileAgent.remove(chat.id)); }}>删除此手机对话</button></p>
      {chat.entries.map(e => e.role === 'tool' ? <details className="hub-card" key={e.id}><summary>{e.tool} · {({ approval: '等待授权', executing: '执行中', done: '已返回结果', denied: '未执行', unknown: '结果不确定' } as Record<string, string>)[e.state ?? '']}</summary><pre>{e.input}</pre><pre>{e.text}</pre></details> : <article className={'hub-message hub-' + e.role} key={e.id}><small>{e.role === 'user' ? '你' : e.role === 'notice' ? '执行状态' : 'DogO · 手机'}</small><pre>{e.text}</pre></article>)}
      {state.approval && <section className="hub-card phone-approval" role="alertdialog" aria-label="手机工具授权"><h3>允许这次工具调用？</h3><p>{state.approval.name}</p><pre>{state.approval.input}</pre><p>读取结果会发送到配置的模型 API；写入或委派可能产生实际操作。只授权本次。</p><button onClick={() => mobileAgent.answer(state.approval!.id, false)}>拒绝</button><button className="hub-primary" onClick={() => mobileAgent.answer(state.approval!.id, true)}>允许本次</button></section>}
      <form className="hub-reply" onSubmit={e => { e.preventDefault(); void action(async () => { await mobileAgent.draft(chat.id, draft); setDraft(''); await mobileAgent.send(chat.id); }); }}>
        <textarea aria-label="手机对话输入" placeholder="只在手机上聊，或明确委派电脑任务…" value={draft} maxLength={32000} rows={4} onChange={e => { setDraft(e.target.value); void mobileAgent.draft(chat.id, e.target.value).catch(e => setError(e.message)); }} />
        {busy ? <button type="button" onClick={() => mobileAgent.stop()}>停止手机执行</button> : <button className="hub-primary" disabled={!draft.trim()}>发送</button>}
      </form>
    </>}
  </section>;
}

export function AgentSettings() {
  const [config, setConfig] = useState<AgentConfigInput>(), [notice, setNotice] = useState(''), [saving, setSaving] = useState(false);
  const state = useSyncExternalStore(mobileAgent.subscribe, mobileAgent.snapshot), busy = state.chats.some(c => c.state === 'running');
  useEffect(() => { void agentTransport.status().then(value => setConfig(value)).catch(e => setNotice(e.message)); }, []);
  const update = (patch: Partial<AgentConfigInput>) => setConfig(value => value && ({ ...value, ...patch }));
  if (!config) return <section className="hub-card"><h3>手机独立 Agent</h3><p>{notice || '读取配置…'}</p></section>;
  return <section className="hub-card phone-agent-settings"><h3>手机独立 Agent</h3><p>使用 Vercel AI SDK，不是 Android 版 DSH。API Key 经 Android Keystore 加密保存，界面不会读回；对话和获准读取的工具内容会发送到所选模型服务。</p>
    <fieldset disabled={saving || busy}><legend>OpenAI-compatible 模型 API</legend>
      <label>API 基础地址（包含 /v1 等所需路径）<input type="url" placeholder="https://api.example.com/v1" value={config.endpoint} onChange={e => update({ endpoint: e.target.value })} /></label>
      <label>模型名称<input placeholder="填写服务提供的模型 ID" value={config.model} maxLength={200} onChange={e => update({ model: e.target.value })} /></label>
      <label>API Key（留空保留；更换地址会清除旧密钥）<input type="password" autoComplete="new-password" value={config.apiKey ?? ''} onChange={e => update({ apiKey: e.target.value })} /></label>
      <label><input type="checkbox" checked={!!config.clearKey} onChange={e => update({ clearKey: e.target.checked })} />清除模型密钥</label>
      <label><input type="checkbox" checked={!!config.memoryMaintenance} onChange={e => update({ memoryMaintenance: e.target.checked })} />允许手机在前台自动尝试一次个人记忆冲突合并</label><p>开启会把冲突文件的三方文本发送到此模型 API；仅在记忆同步和服务端维护策略也允许时运行。失败或事实矛盾转人工，切后台停止，不自动重试。</p>
      <details><summary>远程 MCP 工具（{config.mcp.length}）</summary><p>支持 HTTPS Streamable HTTP 的请求/响应工具和 Bearer 密钥；不支持本机 stdio、旧版 SSE、OAuth 登录或后台订阅。每次工具调用需确认。</p>
        {config.mcp.map((server, index) => <div className="hub-card" key={server.id}>
          <label>名称<input maxLength={100} value={server.name} onChange={e => update({ mcp: config.mcp.map((v, i) => i === index ? { ...v, name: e.target.value } : v) })} /></label>
          <label>MCP 完整地址<input type="url" value={server.url} placeholder="https://example.com/mcp" onChange={e => update({ mcp: config.mcp.map((v, i) => i === index ? { ...v, url: e.target.value } : v) })} /></label>
          <label>Bearer Key · {server.hasKey ? '已保存' : '未保存'}<input type="password" autoComplete="new-password" value={server.apiKey ?? ''} onChange={e => update({ mcp: config.mcp.map((v, i) => i === index ? { ...v, apiKey: e.target.value } : v) })} /></label>
          <label><input type="checkbox" checked={!!server.clearKey} onChange={e => update({ mcp: config.mcp.map((v, i) => i === index ? { ...v, clearKey: e.target.checked } : v) })} />清除此服务密钥</label>
          <label><input type="checkbox" checked={server.enabled} onChange={e => update({ mcp: config.mcp.map((v, i) => i === index ? { ...v, enabled: e.target.checked } : v) })} />启用此 MCP 服务</label>
          <button type="button" onClick={() => update({ mcp: config.mcp.filter((_, i) => i !== index) })}>移除此配置（保存后生效）</button>
        </div>)}
        <button type="button" disabled={config.mcp.length >= 6} onClick={() => update({ mcp: [...config.mcp, { id: crypto.randomUUID().slice(0, 8), name: 'MCP', url: '', hasKey: false, enabled: false }] })}>添加 MCP</button>
      </details>
      <details><summary>文本 Skill（{config.skills.length}）</summary><p>仅加载你审核过的 Markdown 指令；不执行脚本，不访问桌面路径。启用的内容会发送给模型。</p>
        {config.skills.map((skill, index) => <div className="hub-card" key={index}><label>名称<input maxLength={100} value={skill.name} onChange={e => update({ skills: config.skills.map((v, i) => i === index ? { ...v, name: e.target.value } : v) })} /></label><label>指令<textarea rows={6} maxLength={16000} value={skill.text} onChange={e => update({ skills: config.skills.map((v, i) => i === index ? { ...v, text: e.target.value } : v) })} /></label><label><input type="checkbox" checked={skill.enabled} onChange={e => update({ skills: config.skills.map((v, i) => i === index ? { ...v, enabled: e.target.checked } : v) })} />启用</label><button type="button" onClick={() => update({ skills: config.skills.filter((_, i) => i !== index) })}>移除此 Skill</button></div>)}
        <button type="button" disabled={config.skills.length >= 12} onClick={() => update({ skills: [...config.skills, { name: '新 Skill', text: '', enabled: false }] })}>添加文本 Skill</button>
        <label>导入 Markdown<input type="file" accept=".md,.txt,text/plain,text/markdown" disabled={config.skills.length >= 12} onChange={async e => { try { const file = e.target.files?.[0]; if (!file) return; if (file.size > 16000) throw new Error('Skill 文件限 16 KB'); update({ skills: [...config.skills, { name: file.name.slice(0, 100), text: await file.text(), enabled: false }] }); } catch (e) { setNotice((e as Error).message); } }} /></label>
      </details>
      <button className="hub-primary" onClick={async () => { setSaving(true); phoneMaintenance.stop(); try { setConfig(await agentTransport.configure(config)); setNotice('已安全保存。可到“对话”发一条测试消息。'); } catch (e) { setNotice((e as Error).message); } finally { setSaving(false); } }}>保存手机 Agent 配置</button>
    </fieldset>{busy && <p>请先停止当前手机执行，再修改配置。</p>}{notice && <p role="status">{notice}</p>}
  </section>;
}
