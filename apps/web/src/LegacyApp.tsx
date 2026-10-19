import React, { useEffect, useRef, useState } from "react";
import {
  ArrowDownLeft,
  ArrowUpRight,
  Check,
  ChevronRight,
  Copy,
  FolderOpen,
  Inbox,
  Layers,
  MessageSquare,
  Monitor,
  Plus,
  Search,
  Send,
  Settings2,
  ShieldCheck,
  Square,
  TerminalSquare,
  WifiOff,
  X,
} from "lucide-react";
import {
  bridge,
  isPreview,
  type Snapshot,
  type Task,
  type TaskStatus,
  type Settings,
} from "./bridge";
import "./style.css";

const statusLabel: Record<TaskStatus, string> = {
  queued: "等待执行",
  running: "执行中",
  succeeded: "已完成",
  failed: "执行失败",
  cancelled: "已停止",
  interrupted: "运行中断",
};
const date = (value: string) =>
  new Date(value).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  });
const shortPath = (value?: string) =>
  value?.split(/[\\/]/).filter(Boolean).at(-1) ?? "无目录授权";
function Dog({ small = false }: { small?: boolean }) {
  return (
    <div className={`dog ${small ? "small" : ""}`} aria-hidden="true">
      <span />
      <i />
      <b />
    </div>
  );
}
function Status({ task }: { task: Task }) {
  return (
    <span className={`badge ${task.status}`}>
      <span className={task.status === "running" ? "pulse" : ""} />
      {statusLabel[task.status]}
    </span>
  );
}

export default function LegacyApp({ initialPage = 'tasks' }: { initialPage?: string }) {
  const [state, setState] = useState<Snapshot>();
  const [error, setError] = useState("");
  const [page, setPage] = useState(initialPage);
  const [selected, setSelected] = useState<string>();
  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [compose, setCompose] = useState(false);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [followup, setFollowup] = useState("");
  const [draft, setDraft] = useState("");
  const [kind, setKind] = useState<"inspect" | "analysis">("analysis");
  const [workspaceId, setWorkspaceId] = useState("");
  const [settings, setSettings] = useState<Settings>();
  const [notice, setNotice] = useState("");
  const resultRef = useRef<HTMLPreElement>(null);
  useEffect(() => {
    let live = true;
    const receive = (s: Snapshot) => {
      if (live) setState(s);
    };
    const off = bridge.subscribe(receive);
    bridge
      .snapshot()
      .then(receive)
      .catch((e) => setError(e.message));
    return () => {
      live = false;
      off();
    };
  }, []);
  useEffect(() => {
    if (state?.settings) setSettings(state.settings);
  }, [
    state?.settings.endpoint,
    state?.settings.model,
    state?.settings.contextWindow,
    state?.settings.maxTokens,
    state?.settings.relayUrl,
  ]);
  const task = state?.tasks.find((t) => t.id === selected);
  const active = state?.tasks.filter((t) => t.status === "running").length ?? 0;
  const online = state?.runtime === "ready";
  async function action(fn: () => Promise<unknown>) {
    setError("");
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function openCompose(mode: "inspect" | "analysis" = "analysis", prompt = "") {
    setKind(mode);
    setDraft(prompt);
    setCompose(true);
    setError("");
  }
  async function choose() {
    await action(async () => {
      const folder = await bridge.chooseWorkspace();
      if (folder) setWorkspaceId(folder.id);
    });
  }
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    await action(async () => {
      const id = await bridge.create({
        kind,
        prompt: draft,
        workspaceId: workspaceId || undefined,
      });
      setSelected(id);
      setPage("tasks");
      setCompose(false);
      setDraft("");
    });
  }
  const tasks =
    state?.tasks.filter(
      (t) =>
        (filter === "all" ||
          (filter === "attention"
            ? ["failed", "interrupted"].includes(t.status)
            : t.status === filter)) &&
        `${t.title} ${t.prompt}`.toLowerCase().includes(search.toLowerCase()),
    ) ?? [];
  function select(t: Task) {
    setSelected(t.id);
    setPage("tasks");
    setFollowup("");
  }
  return (
    <div className="app">
      <aside className="sidebar" inert={compose}>
        <div className="traffic-space" />
        <div className="brand">
          <Dog small />
          <div>
            DogO<span>狗蛋 · 个人助理</span>
          </div>
          <span className="build">α</span>
        </div>
        <button
          className="new-task"
          onClick={() => openCompose()}
          disabled={!online}
        >
          <Plus size={17} /> 旧版兼容任务 <kbd>＋</kbd>
        </button>
        <div className="nav-label">历史与兼容入口</div>
        <nav>
          {[
            { id: "tasks", label: "历史任务", icon: Inbox },
            { id: "remote", label: "旧版收件", icon: ArrowDownLeft },
            { id: "settings", label: "模型与连接配置", icon: Settings2 },
          ].map(({ id, label, icon: Icon }) => (
            <button
              className={page === id ? "active" : ""}
              key={id}
              onClick={() => {
                setPage(id);
                setNotice("");
              }}
            >
              <Icon size={18} />
              {label}
              {id === "tasks" && (
                <span className="count">{state?.tasks.length ?? 0}</span>
              )}
            </button>
          ))}
        </nav>
        <div className="nav-label section-label">最近任务</div>
        <div className="recent">
          {state?.tasks.slice(0, 5).map((t) => (
            <button key={t.id} onClick={() => select(t)}>
              <span className={`task-dot ${t.status}`} />
              <span>{t.title}</span>
            </button>
          ))}
          {!state?.tasks.length && <p>新的想法，从一个任务开始。</p>}
        </div>
        <div className="sidebar-bottom">
          <div className="local-device">
            <div className="device-icon">
              <Monitor size={18} />
            </div>
            <div>
              <strong>本机工作站</strong>
              <span>
                <i className={online ? "green-dot" : "grey-dot"} />
                {online ? "本地运行服务就绪" : "运行服务未连接"}
              </span>
            </div>
          </div>
          <button className="relay-note" onClick={() => setPage("settings")}>
            <WifiOff size={14} /> {state?.relay?.connected ? '中转服务已连接' : '中转服务未连接'} <ChevronRight size={14} />
          </button>
          <div className="version">
            LOCAL FIRST <span>v0.1 · 开发预览</span>
          </div>
        </div>
      </aside>
      <main inert={compose}>
        <header className="topbar">
          <div>
            <span className="breadcrumb">DogO</span>
            <ChevronRight size={13} />
            <strong>
              {page === "home"
                ? "工作台"
                : page === "tasks"
                  ? "本机任务"
                  : page === 'hub' ? '跨端会话与资料' : page === 'remote' ? '旧版远端收件' : "设置"}
            </strong>
          </div>
          <div className="top-state">
            <span className={active ? "green-dot" : "grey-dot"} />
            {active ? `${active} 个任务执行中` : "现在空闲"}
            <span className="separator" />
            <Monitor size={14} />
            <span>此设备</span>
          </div>
        </header>
        {isPreview && (
          <div className="preview-bar">
            交互预览 · 虚构示例数据，不执行本机操作；真实功能请启动 DogO
            桌面版。
          </div>
        )}
        {error && !compose && (
          <div className="error-banner" role="alert">
            {error}
            <button aria-label="关闭错误" onClick={() => setError("")}>
              <X size={16} />
            </button>
          </div>
        )}
        {!online && state && (
          <div className="error-banner">
            本地运行服务已断开。任务状态可能过期，请重启应用；不会自动重新执行。
          </div>
        )}
        <div className="preview-bar">保留旧任务、权限与结果，不迁移或重跑。日常对话请使用上方「工作区」。</div>
        {page === "home" && (
          <div className="dashboard">
            <div className="page-heading">
              <div>
                <p className="eyebrow">YOUR PERSONAL SIDEKICK</p>
                <h1>
                  事情交给狗蛋。<span className="orange-mark">✳</span>
                </h1>
                <p>留在本机执行，随时回来查看。先从一个小任务开始。</p>
              </div>
              <span className="date-label">
                {new Date().toLocaleDateString("zh-CN", {
                  month: "long",
                  day: "numeric",
                  weekday: "long",
                })}
              </span>
            </div>
            <div className="hero">
              <div className="hero-copy">
                <span className="subtle-pill">
                  <span className="green-dot" /> 本机优先 · 由你授权
                </span>
                <h2>
                  你发起，
                  <br />
                  我来接着做。
                </h2>
                <p>
                  聊聊一个想法，或选一个目录进行只读分析。
                  <br />
                  过程、结果和每一次停止，都有记录。
                </p>
                <button
                  className="primary"
                  onClick={() => openCompose()}
                  disabled={!online}
                >
                  开始一个任务 <ArrowUpRight size={17} />
                </button>
              </div>
              <div className="hero-art">
                <div className="orbit orbit-one" />
                <div className="orbit orbit-two" />
                <span className="art-star one">✳</span>
                <Dog />
                <div className="art-ticket">
                  <ShieldCheck size={15} /> 安心待在本机
                </div>
                <span className="art-star two">＋</span>
              </div>
            </div>
            <div className="quick-actions">
              <button
                onClick={() =>
                  openCompose("inspect", "检查目录结构，列出可见文件")
                }
              >
                <div className="quick-icon green">
                  <FolderOpen size={22} />
                </div>
                <div>
                  <strong>先检查一个目录</strong>
                  <span>无需模型 · 不改动任何文件</span>
                </div>
                <ArrowUpRight size={18} />
              </button>
              <button onClick={() => openCompose("analysis")}>
                <div className="quick-icon orange">
                  <MessageSquare size={22} />
                </div>
                <div>
                  <strong>和本地 Agent 聊聊</strong>
                  <span>DSH 驱动 · 可授权只读源码分析</span>
                </div>
                <ArrowUpRight size={18} />
              </button>
            </div>
            <div className="home-bottom">
              <section className="panel">
                <div className="panel-title">
                  <h3>
                    最近的任务 <span>{state?.tasks.length ?? 0}</span>
                  </h3>
                  <button
                    className="text-button"
                    onClick={() => setPage("tasks")}
                  >
                    查看全部 <ChevronRight size={14} />
                  </button>
                </div>
                {state?.tasks.length ? (
                  state.tasks.slice(0, 3).map((t) => (
                    <button
                      className="home-task"
                      key={t.id}
                      onClick={() => select(t)}
                    >
                      <div className="file-icon">
                        {t.kind === "inspect" ? (
                          <FolderOpen size={18} />
                        ) : (
                          <MessageSquare size={18} />
                        )}
                      </div>
                      <div>
                        <strong>{t.title}</strong>
                        <span>
                          {t.source}发起 · {date(t.updatedAt)}
                        </span>
                      </div>
                      <Status task={t} />
                    </button>
                  ))
                ) : (
                  <div className="empty-inline">
                    <Inbox size={28} />
                    <p>还没有任务。第一个任务由你来发起。</p>
                  </div>
                )}
              </section>
              <section className="panel connection-card">
                <div className="panel-title">
                  <h3>设备协作</h3>
                  <span className="soon">{state?.relay?.connected ? '已连接' : '待连接'}</span>
                </div>
                <div className="device-route">
                  <Monitor />
                  <span>··········</span>
                  <ArrowDownLeft />
                </div>
                <h4>一台设备发起，另一台接着做</h4>
                <p>收到 {state?.relay?.inbox.length ?? 0} 个待处理任务。远端任务需在本机确认执行，结束后自动回传。</p>
                <button
                  className="text-button"
                  onClick={() => setPage("remote")}
                >
                  查看远端收件 <ArrowUpRight size={14} />
                </button>
              </section>
            </div>
            <footer>
              <ShieldCheck size={13} />{" "}
              未授权目录不会被读取；远端任务结果会回传给发起设备。
            </footer>
          </div>
        )}
        {page === "tasks" && (
          <div className="task-workspace">
            <section className="task-list">
              <div className="task-list-title">
                <h2>
                  本机任务 <span>{state?.tasks.length ?? 0}</span>
                </h2>
                <button
                  className="icon-button"
                  aria-label="新建任务"
                  onClick={() => openCompose()}
                  disabled={!online}
                >
                  <Plus size={19} />
                </button>
              </div>
              <label className="search">
                <Search size={16} />
                <input
                  placeholder="搜索任务…"
                  aria-label="搜索任务"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </label>
              <div className="filters">
                {[
                  ["all", "全部"],
                  ["running", "进行中"],
                  ["succeeded", "完成"],
                  ["attention", "需关注"],
                ].map(([id, label]) => (
                  <button
                    key={id}
                    className={filter === id ? "selected" : ""}
                    onClick={() => setFilter(id)}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <div className="list-scroll">
                {tasks.map((t) => (
                  <button
                    key={t.id}
                    className={`task-row ${selected === t.id ? "selected" : ""}`}
                    onClick={() => select(t)}
                  >
                    <div>
                      <span className="task-kind">
                        {t.kind === "inspect" ? "目录检查" : t.engine === 'dsh' ? "DSH 分析" : "Pi 历史"}
                      </span>
                      <time>{date(t.updatedAt)}</time>
                    </div>
                    <strong>{t.title}</strong>
                    <p>{t.output?.slice(0, 60) || t.error || "等待结果…"}</p>
                    <div>
                      <Status task={t} />
                      <span className="task-source">{t.source}</span>
                    </div>
                  </button>
                ))}
                {!tasks.length && (
                  <div className="empty-inline">
                    <Search size={25} />
                    <p>这里还没有匹配的任务。</p>
                  </div>
                )}
              </div>
            </section>
            {task ? (
              <section className="task-detail">
                <div className="detail-top">
                  <div>
                    <span className="eyebrow">
                      TASK / {task.id.slice(0, 8)}
                    </span>
                    <h2>{task.title}</h2>
                    <div className="metadata">
                      <Status task={task} />
                      <span>
                        {task.kind === "analysis"
                          ? task.engine === 'dsh' ? "DSH · 只读分析" : "Pi 历史 · 仅查看"
                          : "本机 · 目录检查"}
                      </span>
                      <span>{shortPath(task.workspace)}</span>
                    </div>
                  </div>
                  {task.status === "running" && (
                    <button
                      className="stop"
                      disabled={busy || !online}
                      onClick={() => action(() => bridge.cancel(task.id))}
                    >
                      <Square size={13} />
                      停止
                    </button>
                  )}
                </div>
                <div className="detail-scroll">
                  <div className="request-block">
                    <span className="mini-avatar">你</span>
                    <div>
                      <span className="section-caption">任务指令</span>
                      <p>{task.turns[0]?.prompt ?? task.prompt}</p>
                      {task.workspace && (
                        <div className="folder-label">
                          <FolderOpen size={13} />
                          {task.workspace}
                        </div>
                      )}
                    </div>
                  </div>
                  {task.turns.map((turn, i) => (
                    <React.Fragment key={i}>
                      <div className="previous-turn">
                        <span>DogO · 历史回复</span>
                        <pre>{turn.output}</pre>
                      </div>
                      <div className="request-block">
                        <span className="mini-avatar">你</span>
                        <p>{task.turns[i + 1]?.prompt ?? task.prompt}</p>
                      </div>
                    </React.Fragment>
                  ))}
                  <div className="result-heading">
                    <div className="result-name">
                      <Dog small />
                      <strong>DogO</strong>
                      <span>
                        {task.status === "running" ? "正在处理" : "执行结果"}
                      </span>
                    </div>
                    {task.output && (
                      <button
                        className="text-button"
                        onClick={() =>
                          action(async () => {
                            await bridge.copyResult(task.id);
                            setCopied(true);
                            setTimeout(() => setCopied(false), 1800);
                          })
                        }
                      >
                        {copied ? <Check size={14} /> : <Copy size={14} />}{" "}
                        {copied ? "已复制" : "复制"}
                      </button>
                    )}
                  </div>
                  <pre
                    className={`result-text ${task.status === "running" ? "streaming" : ""}`}
                    ref={resultRef}
                  >
                    {task.output ||
                      (task.status === "running"
                        ? "正在等待执行输出…"
                        : "尚无文本结果。")}
                  </pre>
                  {task.error && (
                    <div className="task-error" role="alert">
                      {task.error}
                    </div>
                  )}
                  <details
                    className="execution-log"
                    open={task.status === "running"}
                  >
                    <summary>
                      <TerminalSquare size={15} />
                      执行记录 <span>{task.logs.length}</span>
                    </summary>
                    {task.logs.map((log, i) => (
                      <div key={i}>
                        <time>{date(log.at)}</time>
                        <span>{log.message}</span>
                      </div>
                    ))}
                  </details>
                </div>
                <div className="detail-bottom">
                  {task.kind === "analysis" &&
                    task.workspace &&
                    task.status === "succeeded" &&
                    !state?.workspaces.some(
                      (w) => w.path === task.workspace,
                    ) && (
                      <div className="reauthorize">
                        <span>继续前请重新授权原目录。</span>
                        <button
                          className="folder-button"
                          onClick={choose}
                          disabled={busy || !online}
                        >
                          <FolderOpen size={14} />
                          选择原目录
                        </button>
                      </div>
                    )}
                  {task.kind === "analysis" && task.engine === 'dsh' && task.status === "succeeded" && !task.remoteId ? (
                    <form
                      className="followup"
                      onSubmit={(e) => {
                        e.preventDefault();
                        action(async () => {
                          await bridge.followup({
                            id: task.id,
                            prompt: followup,
                          });
                          setFollowup("");
                        });
                      }}
                    >
                      <input
                        aria-label="继续对话"
                        placeholder="继续这个任务…"
                        value={followup}
                        onChange={(e) => setFollowup(e.target.value)}
                      />
                      <button
                        aria-label="发送后续消息"
                        className="send-button"
                        disabled={
                          !followup.trim() || busy || !online || active > 0
                        }
                      >
                        <Send size={16} />
                      </button>
                    </form>
                  ) : (
                    <div className="result-footer">
                      <ShieldCheck size={15} />
                      {task.status === "running"
                        ? "关闭窗口后仍会继续；完整退出会停止。"
                        : task.remoteId
                          ? state?.relay?.deliveries?.find(d => d.localId === task.id)?.returned
                            ? "已回传服务器，发起端可读取结果；本机副本已保留。"
                            : state?.relay?.deliveries?.find(d => d.localId === task.id)?.error || "等待回传确认；结果保留在本机，不会自动重跑。"
                          : "结果保留在本机，不会自动重跑或回传。"}
                    </div>
                  )}
                </div>
              </section>
            ) : (
              <section className="no-selection">
                <Dog />
                <h2>所有进展，都在这里。</h2>
                <p>选择一个任务查看指令、执行记录与结果。</p>
                <button
                  className="primary"
                  onClick={() => openCompose()}
                  disabled={!online}
                >
                  <Plus size={16} />
                  新任务
                </button>
              </section>
            )}
          </div>
        )}
        {page === 'remote' && (
          <div className="settings-page">
            <div className="page-heading"><div><p className="eyebrow">REMOTE INBOX</p><h1>远端收件。</h1><p>只接收任务文字；执行方式和目录授权由你在本机决定。</p></div></div>
            <section className="settings-card">
              <p>{state?.relay?.connected ? `已连接 ${state.relay.url}` : state?.relay?.error || '先到设置导入此设备的凭据文件。'}</p>
              <button className="secondary" disabled={busy || !online} onClick={() => action(() => bridge.refreshRelay())}>刷新收件与回传</button>
              <label className="full-field">执行方式<select value={kind} onChange={e => setKind(e.target.value as 'inspect' | 'analysis')}><option value="analysis">本地模型只读分析</option><option value="inspect">只读目录检查（不调用模型）</option></select></label>
              <button className="folder-button" onClick={choose} disabled={busy || !online}><FolderOpen size={16} />{state?.workspaces.find(w => w.id === workspaceId)?.path || '选择并授权本次执行目录（可选）'}</button>
              {!!workspaceId && <button className="text-button" onClick={() => setWorkspaceId('')}>本次不使用目录</button>}
            </section>
            {state?.relay?.inbox.map(incoming => <section className="settings-card" key={incoming.id}>
              <h3>{incoming.title}</h3><p>来自 {incoming.sender} · 等待本机确认</p>
              <pre className="result-text">{incoming.instructions}</pre>
              <p className="field-note">确认后会执行上述任务，并将结果通过中转服务返回发起设备。只读目录检查会回传所选目录的路径和文件名。</p>
              <button className="primary" disabled={busy || !online || active > 0 || !state.relay?.connected} onClick={() => action(async () => {
                const id = await bridge.acceptRemote({ id: incoming.id, kind, workspaceId: workspaceId || undefined });
                setSelected(id); setPage('tasks');
              })}>确认执行并回传</button>
            </section>)}
            {!state?.relay?.inbox.length && <p>暂无待领取任务。离线任务会保留在服务器，重新连接后补收。</p>}
          </div>
        )}
        {page === "settings" && settings && (
          <div className="settings-page">
            <div className="page-heading">
              <div>
                <p className="eyebrow">MAKE IT YOURS</p>
                <h1>让狗蛋准备就绪。</h1>
                <p>模型负责思考，权限留在本机。</p>
              </div>
            </div>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                action(async () => {
                  await bridge.configure(settings);
                  setNotice("设置已保存。仅保存配置，未测试连接。");
                });
              }}
            >
              <section className="settings-card">
                <div className="settings-title">
                  <div><h3>DSH 后端</h3><p>上游 DSH 0.2.0-rc.2 · DogO 独立配置目录</p></div>
                  <span className="soon">{state?.backend?.state === 'ready' ? '已启动' : state?.backend?.state === 'starting' ? '启动中' : '未启动'}</span>
                </div>
                <button type="button" className="secondary" disabled={busy || !online} onClick={() => action(() => bridge.openDsh())}>进入内置工作区 · 模型与插件</button>
                <p className="field-note">{state?.backend?.error || '跨设备任务使用正常 DSH 会话，可在原设备续聊；旧版只读任务保留原限制。关闭窗口继续运行，完全退出停止后端。'}</p>
              </section>
              <section className="settings-card">
                <div className="settings-title">
                  <div className="quick-icon green">
                    <MessageSquare size={20} />
                  </div>
                  <div>
                    <h3>本地模型</h3>
                    <p>OpenAI 兼容接口 · DSH 本地模型适配</p>
                  </div>
                  <span className="soon">
                    {state?.settings.model ? "已配置 · 未探测" : "待配置"}
                  </span>
                </div>
                <div className="settings-fields">
                  <label>
                    接口地址
                    <input
                      value={settings.endpoint}
                      onChange={(e) =>
                        setSettings({ ...settings, endpoint: e.target.value })
                      }
                      required
                      placeholder="http://127.0.0.1:8000/v1"
                    />
                  </label>
                  <label>
                    模型 ID
                    <input
                      value={settings.model}
                      onChange={(e) =>
                        setSettings({ ...settings, model: e.target.value })
                      }
                      placeholder="填写本地服务实际加载的模型 ID"
                      maxLength={160}
                    />
                  </label>
                  <label>
                    上下文窗口
                    <input
                      type="number"
                      min={4096}
                      max={131072}
                      step={1}
                      value={settings.contextWindow}
                      onChange={(e) =>
                        setSettings({
                          ...settings,
                          contextWindow: Number(e.target.value),
                        })
                      }
                    />
                  </label>
                  <label>
                    最大输出 token
                    <input
                      type="number"
                      min={256}
                      max={32768}
                      step={1}
                      value={settings.maxTokens}
                      onChange={(e) =>
                        setSettings({
                          ...settings,
                          maxTokens: Number(e.target.value),
                        })
                      }
                    />
                  </label>
                </div>
                <p className="field-note">
                  当前仅接受本机 HTTP 地址，无 API
                  key。配置不修改模型服务器自身限制；源码分析会把授权文件发送给此本地模型。会话启用
                  DSH 自动压缩，真实长上下文尚待测试。
                </p>
              </section>
              <section className="settings-card">
                <div className="settings-title">
                  <div className="quick-icon orange">
                    <Monitor size={20} />
                  </div>
                  <div>
                    <h3>跨设备协作</h3>
                    <p>消息中转与记忆同步分别接入</p>
                  </div>
                  <span className="soon">{state?.relay?.connected ? '已连接' : '未连接'}</span>
                </div>
                <label className="full-field">
                  当前设备绑定的中转服务
                  <input
                    value={state?.relay?.url || ''}
                    readOnly
                    placeholder="导入设备凭据后显示"
                  />
                </label>
                <button type="button" className="secondary" disabled={busy || active > 0 || !online} onClick={() => action(() => bridge.importRelay())}>导入此设备凭据文件</button>
                <button type="button" className="text-button" disabled={busy || !online} onClick={() => action(() => bridge.refreshRelay())}>刷新连接</button>
                <p className="field-note">
                  {state?.relay?.error || '凭据由系统加密保存，不传入网页。跨设备页面的设置可开启无人值守执行、个人记忆同步及登录自启；旧版收件仍保留人工确认。'}
                </p>
              </section>
              <section className="settings-card">
                <div className="settings-title">
                  <div className="quick-icon grey">
                    <ShieldCheck size={20} />
                  </div>
                  <div>
                    <h3>能力与边界</h3>
                    <p>只展示真实可用的能力</p>
                  </div>
                </div>
                <div className="capabilities">
                  {[
                    ["目录检查 / 源码只读", "选择目录后授权", "available"],
                    ["本地任务 / 会话持久化", "已实现", "available"],
                    ["屏幕查看 / 点击 / 输入", "待接入", ""],
                    ["Codex 编码 / SSH 终端", "待接入", ""],
                    ["任务收件 / 结果回传", "设备配对后可用", "available"],
                    ["全局个人记忆", state?.memory?.enabled ? "专用目录同步已开启" : "在跨设备设置中开启", ""],
                  ].map(([name, label, cls]) => (
                    <div key={name}>
                      <span>{name}</span>
                      <span className={cls}>{label}</span>
                    </div>
                  ))}
                </div>
                <p className="field-note">
                  关闭窗口：继续后台运行。完整退出：停止任务。异常退出：标记中断、不自动重跑。目录权限每次重启需重新授予。只读过滤不能识别所有敏感内容，请仅选择确认可供模型读取的目录。
                </p>
              </section>
              <div className="save-row">
                <span role="status">{notice}</span>
                <button
                  className="primary"
                  disabled={busy || active > 0 || !online}
                >
                  <Check size={16} /> 保存设置
                </button>
              </div>
            </form>
          </div>
        )}
      </main>
      {compose && (
        <div
          className="modal-backdrop"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setCompose(false);
          }}
        >
          <section
            className="compose-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="compose-title"
            onKeyDown={(e) => {
              if (e.key === "Escape") setCompose(false);
            }}
          >
            <div className="modal-heading">
              <div>
                <span className="eyebrow">A LITTLE HELP, A LOT DONE</span>
                <h2 id="compose-title">交给狗蛋一件事。</h2>
              </div>
              <button
                aria-label="关闭新任务"
                className="icon-button"
                onClick={() => setCompose(false)}
              >
                <X size={20} />
              </button>
            </div>
            <form onSubmit={submit}>
              <div className="mode-select">
                <button
                  type="button"
                  className={kind === "analysis" ? "selected" : ""}
                  onClick={() => setKind("analysis")}
                >
                  <MessageSquare size={16} />
                  DSH 分析 / 对话
                </button>
                <button
                  type="button"
                  className={kind === "inspect" ? "selected" : ""}
                  onClick={() => {
                    setKind("inspect");
                    if (!draft) setDraft("检查目录结构，列出可见文件");
                  }}
                >
                  <FolderOpen size={16} />
                  目录检查
                </button>
              </div>
              <label className="draft-label" htmlFor="task-prompt">
                任务内容
              </label>
              <textarea
                id="task-prompt"
                autoFocus
                placeholder={
                  kind === "analysis"
                    ? "想分析什么？需要读取源码时，请选择下面的目录。"
                    : "说明本次目录检查的目的…"
                }
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                maxLength={16000}
                required
              />
              <div className="workspace-picker">
                <button
                  type="button"
                  className="folder-button"
                  onClick={choose}
                  disabled={busy}
                >
                  <FolderOpen size={16} />
                  {workspaceId
                    ? shortPath(
                        state?.workspaces.find((w) => w.id === workspaceId)
                          ?.path,
                      )
                    : "选择只读目录"}
                  <ChevronRight size={14} />
                </button>
                {workspaceId && (
                  <button
                    type="button"
                    className="icon-button"
                    aria-label="移除本次目录"
                    onClick={() => setWorkspaceId("")}
                  >
                    <X size={15} />
                  </button>
                )}
                <span>
                  {kind === "inspect"
                    ? "必选 · 不读取文件内容"
                    : "可选 · 可读取普通源码文件"}
                </span>
              </div>
              <div className="permission-note">
                <ShieldCheck size={16} />
                <span>
                  {kind === "inspect"
                    ? "无需模型，仅列出文件结构。不会执行命令或修改文件。"
                    : "仅使用已配置的本地模型。文件只读，不执行命令、不修改代码。"}
                  {kind === "analysis" &&
                    !state?.settings.model &&
                    !isPreview &&
                    " 尚未配置模型，请先到设置填写模型 ID。"}
                </span>
              </div>
              {error && (
                <div className="task-error" role="alert">
                  {error}
                </div>
              )}
              <div className="modal-footer">
                <span>
                  <Monitor size={14} /> 在本机执行{isPreview ? "（演示）" : ""}
                </span>
                <button
                  className="primary"
                  disabled={
                    busy ||
                    !draft.trim() ||
                    active > 0 ||
                    !online ||
                    (kind === "inspect" && !workspaceId)
                  }
                >
                  <ArrowUpRight size={17} />
                  {active ? "已有任务运行中" : "开始任务"}
                </button>
              </div>
            </form>
          </section>
        </div>
      )}
    </div>
  );
}
