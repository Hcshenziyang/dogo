import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { FormEvent, ReactNode } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Bell,
  Check,
  CheckCheck,
  ChevronRight,
  CircleCheck,
  Clock3,
  FileText,
  Inbox,
  Laptop,
  ListTodo,
  LoaderCircle,
  Monitor,
  Plus,
  RefreshCw,
  Search,
  Send,
  Settings2,
  ShieldCheck,
  Smartphone,
  WifiOff,
  X,
  Copy,
  Share2,
  Plug,
  Info,
} from "lucide-react";
import {
  createDemoTask,
  decideTask,
  devices,
  filterTasks,
  initialTasks,
  statusText,
} from "./model.ts";
import type { DeviceId, Filter, Tab, Task } from "./model.ts";
import {
  connectionSchema,
  createOutboxTask,
  displayTime,
  emptyDraft,
  retractOutbox,
  taskText,
} from "./workspace.ts";
import type { Draft, Mode } from "./workspace.ts";
import {
  copyText,
  minimize,
  native,
  registerBack,
  repository,
  shareText,
  relay,
} from "./platform.ts";
import type { RelayStatus } from './relay.ts';

function DogMark({ small = false }: { small?: boolean }) {
  return (
    <span className={`dog-mark ${small ? "small" : ""}`} aria-hidden="true">
      <svg viewBox="0 0 40 40" fill="none">
        <path
          d="M11 12 6 7 4 20c0 5 3 7 6 5m19-13 5-5 2 13c0 5-3 7-6 5"
          fill="currentColor"
        />
        <rect x="9" y="10" width="22" height="23" rx="10" fill="currentColor" />
        <circle cx="15" cy="19" r="1.8" fill="#fff" />
        <circle cx="25" cy="19" r="1.8" fill="#fff" />
        <path d="M17 25h6l-3 3-3-3Z" fill="#fff" />
      </svg>
    </span>
  );
}

function DeviceIcon({ id, size = 18 }: { id: DeviceId; size?: number }) {
  return id === "phone" ? (
    <Smartphone size={size} />
  ) : id === "mac" ? (
    <Laptop size={size} />
  ) : (
    <Monitor size={size} />
  );
}

function StatusIcon({ task }: { task: Task }) {
  return task.status === "succeeded" ? (
    <Check size={19} />
  ) : task.status === "queued" || task.status === "outbox" ? (
    <Clock3 size={19} />
  ) : task.status === "approval" ? (
    <ShieldCheck size={19} />
  ) : task.status === "failed" || task.status === "cancelled" ? (
    <X size={19} />
  ) : (
    <LoaderCircle size={19} className="spin" />
  );
}

function Sheet({
  title,
  children,
  onClose,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current!;
    element.showModal();
    return () => {
      element.close();
    };
  }, []);
  return (
    <dialog
      ref={dialog}
      className="sheet"
      aria-label={title}
      onCancel={onClose}
      onClick={(event) => {
        if (event.target === dialog.current) onClose();
      }}
    >
      <div className="sheet-content">
        <div className="sheet-handle" />
        <header className="sheet-header">
          <h2>{title}</h2>
          <button
            className="icon-button"
            aria-label="关闭弹窗"
            onClick={onClose}
          >
            <X size={21} />
          </button>
        </header>
        {children}
      </div>
    </dialog>
  );
}

const tabs: { id: Tab; label: string; icon: typeof Inbox }[] = [
  { id: "inbox", label: "收件箱", icon: Inbox },
  { id: "tasks", label: "任务", icon: ListTodo },
  { id: "settings", label: "设置", icon: Settings2 },
];
const filters: { id: Filter; label: string }[] = [
  { id: "all", label: "全部" },
  { id: "attention", label: "待处理" },
  { id: "active", label: "进行中" },
  { id: "done", label: "已完成" },
];

export function App() {
  const workspace = useSyncExternalStore(
    repository.subscribe,
    repository.snapshot,
  );
  const mode = workspace.mode;
  const demo = mode === "demo";
  const tasks: Task[] = demo ? workspace.demoTasks : workspace.localTasks;
  const [storageError, setStorageError] = useState<string | null>(
    repository.recovered
      ? "已从上一份本地备份恢复，请核对最近的任务。原始数据未主动清除。"
      : null,
  );
  const [saving, setSaving] = useState(false);
  const [tab, setTab] = useState<Tab>("inbox");
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [sheet, setSheet] = useState<
    | "compose"
    | "notifications"
    | "preview"
    | "connection"
    | "about"
    | "retract"
    | null
  >(null);
  const [composeDevice, setComposeDevice] = useState<DeviceId>("mac");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [toast, setToast] = useState<string | null>(null);
  const [toastTask, setToastTask] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [lastSync, setLastSync] = useState("未同步");
  const [connection, setConnection] = useState(workspace.connection);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [relayState, setRelayState] = useState<RelayStatus>({ configured: false, url: '', device: '' });
  const [relayError, setRelayError] = useState('');
  const [networkBusy, setNetworkBusy] = useState(false);
  const contentRef = useRef<HTMLElement>(null);
  const selected = tasks.find((task) => task.id === selectedId);
  const unread = tasks.filter((task) => task.unread).length;
  const pending = tasks.filter((task) => task.status === "approval").length;
  const activeTab = tab === "devices" ? "settings" : tab;
  const backAction = useRef<() => void>(() => {});
  backAction.current = () => {
    if (sheet) setSheet(null);
    else if (selectedId) setSelectedId(null);
    else if (tab === "devices") navigate("settings");
    else if (tab !== "inbox") navigate("inbox");
    else void minimize();
  };
  useEffect(() => {
    const handle = registerBack(() => backAction.current());
    return () => {
      void handle.then((value) => value.remove());
    };
  }, []);
  useEffect(() => {
    if (demo || !native) return;
    let active = true; let polling = false;
    const poll = async () => {
      if (polling || document.hidden) return;
      polling = true;
      try { const status = await relay.refresh(); if (active) { setRelayState(status); setRelayError(''); } }
      catch (error) { if (active) setRelayError((error as Error).message); }
      finally { polling = false; }
    };
    void poll();
    const timer = setInterval(() => void poll(), 10000);
    document.addEventListener('visibilitychange', poll);
    return () => { active = false; clearInterval(timer); document.removeEventListener('visibilitychange', poll); };
  }, [demo]);
  async function networkAction(action: () => Promise<unknown>) {
    if (networkBusy || demo) return;
    setNetworkBusy(true); setRelayError('');
    try { await action(); setRelayState(await relay.native.status()); }
    catch (error) { setRelayError((error as Error).message); setToast((error as Error).message); }
    finally { setNetworkBusy(false); }
  }
  async function importPairing() {
    await networkAction(async () => {
      const status = await relay.native.importPairing();
      await repository.update(current => ({ ...current, connection: { ...current.connection, url: status.url } }));
      setConnection(current => ({ ...current, url: status.url }));
      setToast('手机已配对；已有待发送任务仍需逐条确认发送');
    });
  }
  function reportError(error: unknown) {
    setStorageError(
      error instanceof Error
        ? error.message
        : "保存失败，请检查手机剩余空间后重试",
    );
  }
  function setTasks(update: Task[] | ((current: Task[]) => Task[])) {
    const key = demo ? "demoTasks" : "localTasks";
    return repository
      .update((current) => ({
        ...current,
        [key]: typeof update === "function" ? update(current[key]) : update,
      }))
      .then(() => true)
      .catch((error) => {
        reportError(error);
        return false;
      });
  }
  function saveDraft(next: Draft) {
    setTitle(next.title);
    setDescription(next.description);
    setComposeDevice(next.device);
    void repository
      .update((current) => ({
        ...current,
        drafts: { ...current.drafts, [mode]: next },
      }))
      .catch(reportError);
  }
  async function switchMode(next: Mode) {
    try {
      await repository.update((current) => ({ ...current, mode: next }));
      navigate("inbox");
      setSheet(null);
      setLastSync("未同步");
      setToast(
        next === "demo"
          ? "已进入独立演示沙盒，真实任务不受影响"
          : "已回到本地工作台",
      );
    } catch (error) {
      reportError(error);
    }
  }
  async function saveConnection(event: FormEvent) {
    event.preventDefault();
    const parsed = connectionSchema.safeParse({
      ...connection,
      url: connection.url.trim(),
    });
    if (!parsed.success) {
      setConnectionError(parsed.error.issues[0].message);
      return;
    }
    try {
      await repository.update((current) => ({
        ...current,
        connection: parsed.data,
      }));
      setSheet(null);
      setToast("路径预配置已保存；设备凭据不变，没有发送任务");
    } catch (error) {
      reportError(error);
    }
  }
  function openConnection() {
    setConnection(workspace.connection);
    setConnectionError(null);
    setSheet("connection");
  }
  async function shareTask(task: Task, copy = false) {
    try {
      const content = `${demo ? "【DogO 演示记录，未真实执行】\n\n" : ""}${taskText(task)}`;
      if (copy) {
        await copyText(content);
        setToast("任务内容已复制");
      } else setToast(await shareText(task.title, content));
    } catch {
      setToast("未完成分享或复制，原任务仍保留");
    }
  }
  async function retractSelected() {
    if (!selected || demo) return;
    try {
      await repository.update((current) => ({
        ...current,
        localTasks: retractOutbox(current.localTasks, selected.id),
      }));
      setSheet(null);
      setToast("已撤回本地待发送任务，记录仍然保留");
    } catch (error) {
      reportError(error);
    }
  }

  useEffect(() => {
    contentRef.current?.scrollTo({ top: 0 });
  }, [tab, selectedId]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => {
      setToast(null);
      setToastTask(null);
    }, 5000);
    return () => clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    if (!syncing) return;
    const timer = setTimeout(() => {
      setSyncing(false);
      setLastSync("刚刚（演示）");
      setToastTask(null);
      setToast("演示同步完成，没有上传任何文件");
    }, 1000);
    return () => clearTimeout(timer);
  }, [syncing]);

  function openTask(taskId: string) {
    setSelectedId(taskId);
    setSheet(null);
    setToast(null);
    setTasks((current) =>
      current.map((task) =>
        task.id === taskId ? { ...task, unread: false } : task,
      ),
    );
  }
  function navigate(next: Tab) {
    setTab(next);
    setSelectedId(null);
    setFilter("all");
    setSearch("");
  }
  function newTask(device: DeviceId = "mac", followup?: Task) {
    const draft = workspace.drafts[mode];
    if (draft.title || draft.description) {
      setComposeDevice(draft.device);
      setTitle(draft.title);
      setDescription(draft.description);
      setToast("已恢复未发送草稿，请先完成或清空当前草稿");
    } else {
      saveDraft({
        device,
        title: followup ? `继续：${followup.title}`.slice(0, 100) : "",
        description: followup
          ? `基于任务「${followup.title}」的结果，接下来：\n`
          : "",
      });
    }
    setSheet("compose");
  }
  async function submitTask(event: FormEvent) {
    event.preventDefault();
    if (saving || !title.trim() || !description.trim()) return;
    setSaving(true);
    try {
      const task = demo
        ? createDemoTask(title, description, composeDevice)
        : createOutboxTask(
            { title, description, device: composeDevice },
            workspace.connection,
          );
      await repository.update((current) => {
        const key = demo ? "demoTasks" : "localTasks";
        return {
          ...current,
          [key]: [task, ...current[key]],
          drafts: { ...current.drafts, [mode]: emptyDraft() },
        };
      });
      setTitle("");
      setDescription("");
      setSheet(null);
      setSelectedId(task.id);
      setTab("tasks");
      setToastTask(null);
      setToast(
        demo
          ? "已保存到演示信箱，未向真实设备发送"
          : "已保存到此手机，连接服务后再发送",
      );
    } catch (error) {
      reportError(error);
    } finally {
      setSaving(false);
    }
  }
  async function decide(id: string, allow: boolean) {
    if (!(await setTasks((current) => decideTask(current, id, allow)))) return;
    setToastTask(null);
    setToast(allow ? "演示：已允许本次修改" : "演示：已拒绝本次修改");
  }
  async function simulateResult() {
    if (!demo) {
      void switchMode("demo");
      return;
    }
    const running =
      (selected && ["running", "queued"].includes(selected.status)
        ? selected
        : null) ??
      tasks.find((task) => ["running", "queued"].includes(task.status));
    if (!running) {
      setToastTask(null);
      setToast("没有进行中的演示任务，可以先重置预览");
      return;
    }
    const saved = await setTasks((current) =>
      current.map((task) =>
        task.id !== running.id
          ? task
          : {
              ...task,
              status: "succeeded",
              unread: true,
              time: "刚刚",
              description: "执行结果已回到手机，可以继续查看或发起后续任务。",
              result: [
                "本条为模拟返回消息，验证手机端接收与阅读交互。",
                "没有在任何设备上执行代码、修改文件或运行测试。",
              ],
              activity: [
                ...task.activity,
                { label: "结果已回传手机（演示）", time: "刚刚" },
              ],
            },
      ),
    );
    if (!saved) return;
    setToast(`新结果：${running.title}`);
    setToastTask(running.id);
    setSheet(null);
  }
  function taskCard(task: Task) {
    return (
      <button
        key={task.id}
        className={`task-card ${task.status}`}
        onClick={() => openTask(task.id)}
      >
        <span className={`task-icon ${task.status}`}>
          <StatusIcon task={task} />
        </span>
        <span className="task-copy">
          <span className="task-topline">
            <span>{statusText[task.status]}</span>
            <span>{displayTime(task)}</span>
          </span>
          <span className="task-title">
            {task.title}
            {task.unread && <span className="unread-dot" aria-label="未读" />}
          </span>
          <span className="task-description">{task.description}</span>
          <span className="task-footer">
            <span>
              <DeviceIcon id={task.device} size={13} />
              {devices.find((d) => d.id === task.device)!.name}
            </span>
            <span>
              {task.category}
              <ChevronRight size={13} />
            </span>
          </span>
        </span>
      </button>
    );
  }

  return (
    <div className="preview-layout">
      <aside className="preview-aside">
        <div className="preview-wordmark">
          <DogMark />
          DogO<span>狗蛋</span>
        </div>
        <span className="eyebrow">A LITTLE ASSISTANCE, EVERYWHERE.</span>
        <h1>
          不在电脑前，
          <br />
          事情也在继续。
        </h1>
        <p>
          把任务交给合适的设备。
          <br />
          需要你时，消息会回到这里。
        </p>
        <div className="preview-notes">
          <span>
            <span>01</span> 发出一个任务
          </span>
          <span>
            <span>02</span> 处理需要你的消息
          </span>
          <span>
            <span>03</span> 带着结果继续
          </span>
        </div>
        <div className="preview-controls">
          <span className="eyebrow">DOGO MOBILE · 0.1</span>
          <button onClick={simulateResult}>
            <Bell size={16} />
            {demo ? "模拟收到结果" : "体验独立演示"}
            <ArrowRight size={16} />
          </button>
          <small>本地保存 · 服务接入另行配置</small>
        </div>
      </aside>

      <div className="phone-shell">
        <div className="preview-label">
          <span>
            <span className="tiny-dot" />
            {demo ? "演示沙盒 · 不执行真实任务" : relayState.configured ? (relayError ? '离线 · 任务保留' : '任务中转已连接') : "本地模式 · 未连接服务"}
          </span>
          <button onClick={() => setSheet("preview")}>
            {demo ? "演示工具" : "模式说明"}
            <Settings2 size={12} />
          </button>
        </div>
        <header className="app-header">
          {selected ? (
            <>
              <button
                className="icon-button back"
                aria-label="返回列表"
                onClick={() => setSelectedId(null)}
              >
                <ArrowLeft size={21} />
              </button>
              <span className="detail-header-title">任务详情</span>
              <span className="small-demo">{demo ? "DEMO" : "本地"}</span>
            </>
          ) : (
            <>
              <button
                className="brand"
                aria-label="DogO 首页"
                onClick={() => navigate("inbox")}
              >
                <DogMark small />
                <span>
                  DogO<span className="brand-caption">随身工作台</span>
                </span>
              </button>
              <button
                className="icon-button bell"
                aria-label={`通知，${unread} 条未读`}
                onClick={() => setSheet("notifications")}
              >
                <Bell size={21} />
                {unread > 0 && <span className="bell-badge">{unread}</span>}
              </button>
            </>
          )}
        </header>

        <main className="screen-main" ref={contentRef}>
          {storageError && (
            <div className="storage-error" role="alert">
              <strong>请留意本地数据</strong>
              <p>{storageError}</p>
              <button
                className="text-button"
                onClick={() => setStorageError(null)}
              >
                知道了
              </button>
            </div>
          )}
          {selected ? (
            <section className="detail-page">
              <div className="detail-meta">
                <span className={`status-pill ${selected.status}`}>
                  <StatusIcon task={selected} />
                  {statusText[selected.status]}
                </span>
                <span>{selected.category}</span>
              </div>
              <h1>{selected.title}</h1>
              <p className="detail-summary">{selected.description}</p>
              <div className="route-card">
                <span>
                  <Smartphone size={19} />
                  <strong>此手机</strong>
                  <small>发起端</small>
                </span>
                <ArrowRight size={17} />
                <span>
                  <DeviceIcon id={selected.device} size={19} />
                  <strong>
                    {devices.find((d) => d.id === selected.device)!.name}
                  </strong>
                  <small>
                    {selected.mailbox ??
                      workspace.connection.routes[selected.device]}
                  </small>
                </span>
              </div>
              {demo && selected.status === "approval" && (
                <section className="approval-detail">
                  <ShieldCheck size={22} />
                  <h2>只授权这一次</h2>
                  <p>
                    允许修改 <code>apps/mobile/</code>{" "}
                    内的页面文件。不包含删除目录、上传数据或执行额外命令。
                  </p>
                  <small>审批界面演示，尚未接入真实权限协议。</small>
                  <div className="button-row">
                    <button
                      className="secondary"
                      onClick={() => decide(selected.id, false)}
                    >
                      不允许
                    </button>
                    <button
                      className="primary"
                      onClick={() => decide(selected.id, true)}
                    >
                      允许本次修改
                      <Check size={16} />
                    </button>
                  </div>
                </section>
              )}
              {(selected.status === "queued" ||
                selected.status === "outbox") && (
                <div className="info-box">
                  <Clock3 size={19} />
                  <div>
                    <strong>
                      {!demo
                        ? selected.sendAttempted ? '发送状态待确认' : "已保存，等待你发送"
                        : devices.find((d) => d.id === selected.device)!.online
                          ? "等待 Agent 领取"
                          : "Windows 暂时离线"}
                    </strong>
                    <p>
                      {demo
                        ? "任务仅在演示沙盒内。可模拟接单或结果返回，不会在任何设备执行。"
                        : selected.sendAttempted ? '网络响应未确认，请重试原任务核对状态；不会重复创建。' : "任务保留在此手机。配对后点击发送，执行设备确认后才会运行。"}
                    </p>
                  </div>
                </div>
              )}
              {selected.result && (
                <section className="result-panel">
                  <div className="section-heading">
                    <h2>
                      <CircleCheck size={18} />
                      执行结果
                    </h2>
                    <span>{demo ? "演示报告" : "返回内容"}</span>
                  </div>
                  {selected.result.map((line, index) => (
                    <p key={index}>
                      <span>{String(index + 1).padStart(2, "0")}</span>
                      {line}
                    </p>
                  ))}
                  <div className="result-note">
                    <FileText size={15} />
                    结果已关联原任务，随时可以回来读。
                  </div>
                </section>
              )}
              <section className="activity">
                <div className="section-heading">
                  <h2>任务动态</h2>
                  <span>{selected.activity.length} 条记录</span>
                </div>
                <ol>
                  {selected.activity.map((item, index) => (
                    <li key={`${item.label}-${index}`}>
                      <span
                        className={`timeline-dot ${index === selected.activity.length - 1 ? "current" : ""}`}
                      />
                      <div>
                        <p>{item.label}</p>
                        <time>{item.time}</time>
                      </div>
                    </li>
                  ))}
                </ol>
              </section>
              {demo && ["queued", "running"].includes(selected.status) && (
                <div className="button-row demo-task-actions">
                  {selected.status === "queued" && (
                    <button
                      className="secondary"
                      onClick={() =>
                        void setTasks((current) =>
                          current.map((task) =>
                            task.id === selected.id
                              ? {
                                  ...task,
                                  status: "running",
                                  activity: [
                                    ...task.activity,
                                    {
                                      label: "已模拟设备接单，未实际执行",
                                      time: "刚刚",
                                    },
                                  ],
                                }
                              : task,
                          ),
                        )
                      }
                    >
                      模拟接单
                    </button>
                  )}
                  <button className="secondary" onClick={simulateResult}>
                    模拟返回结果
                  </button>
                </div>
              )}
              {!demo && selected.status === "outbox" && (
                <div className="button-row demo-task-actions">
                  <button
                    className="secondary"
                    disabled={networkBusy || selected.sendAttempted}
                    onClick={() => setSheet("retract")}
                  >
                    撤回待发送
                  </button>
                  <button className="primary" disabled={networkBusy || !relayState.configured} onClick={() => void networkAction(async () => { await relay.publish(selected.id); setToast('任务已发送'); })}>
                    {networkBusy ? '发送中…' : selected.sendAttempted ? '重试并确认发送状态' : '发送到执行设备'}
                  </button>
                  <button className="secondary" onClick={openConnection}>
                    服务连接
                  </button>
                </div>
              )}
              {!demo && selected.sendAttempted && selected.status === 'outbox' && <p className="footnote">发送状态未确认。请用相同任务重试，服务器会去重；此时不能仅在本地撤回。</p>}
              {!demo && selected.remoteId && <button className="secondary" disabled={networkBusy} onClick={() => void networkAction(() => relay.refresh())}>刷新结果</button>}
              <div className="button-row task-share-actions">
                <button
                  className="secondary"
                  onClick={() => void shareTask(selected, true)}
                >
                  <Copy size={16} />
                  复制内容
                </button>
                <button
                  className="secondary"
                  onClick={() => void shareTask(selected)}
                >
                  <Share2 size={16} />
                  系统分享
                </button>
              </div>
              <button
                className="secondary full"
                onClick={() => newTask(selected.device, selected)}
              >
                <Plus size={17} />
                基于此任务再发一条
              </button>
              <p className="footnote">
                {demo
                  ? "演示记录与真实任务隔离，不会发送至真实设备。"
                  : "记录保存在当前设备。卸载或清除应用数据会删除本地记录。"}
              </p>
            </section>
          ) : tab === "inbox" || tab === "tasks" ? (
            <>
              <section className="greeting">
                <span className="eyebrow">
                  {tab === "inbox"
                    ? "YOUR EVERYDAY SIDEKICK"
                    : "A LITTLE PROGRESS, EVERY DAY"}
                </span>
                <h1>
                  {tab === "inbox"
                    ? demo || unread
                      ? "消息回来了。"
                      : "事情，慢慢来。"
                    : "交出去的事。"}
                  <span className="greeting-mark">
                    {tab === "inbox" ? "✳" : "↗"}
                  </span>
                </h1>
                <p>
                  {tab === "inbox" ? (
                    <>
                      {unread ? `${unread} 条新消息` : "消息都看过了"}
                      {pending
                        ? `，${pending} 件事等你确认。`
                        : "，随时接着往下做。"}
                    </>
                  ) : (
                    "看看进展，或者交给狗蛋一件新任务。"
                  )}
                </p>
              </section>
              {tab === "inbox" && (
                <button
                  className="device-banner"
                  onClick={() => navigate("devices")}
                >
                  <span className="device-stack">
                    <Laptop size={22} />
                    <Smartphone size={18} />
                  </span>
                  <span>
                    <strong>
                      {demo
                        ? "设备在忙，你不用守着。"
                        : "先记下来，接通后再交出去。"}
                    </strong>
                    <small>
                      <span className="online-dot" />
                      {demo
                        ? "2 台在线 / 1 台离线（演示）"
                        : `${tasks.filter((task) => task.status === "outbox").length} 条待发送 · ${relayState.configured ? '已配对' : '未配对'}`}
                    </small>
                  </span>
                  <ArrowRight size={18} />
                </button>
              )}
              {tab === "tasks" && (
                <label className="search-field">
                  <Search size={17} />
                  <input
                    aria-label="搜索任务"
                    placeholder="搜索任务或内容"
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                  />
                  {search && (
                    <button
                      className="icon-button"
                      aria-label="清空搜索"
                      onClick={() => setSearch("")}
                    >
                      <X size={15} />
                    </button>
                  )}
                </label>
              )}
              <div className="filter-row" aria-label="任务筛选">
                {filters.map((item) => (
                  <button
                    key={item.id}
                    aria-pressed={filter === item.id}
                    className={filter === item.id ? "active" : ""}
                    onClick={() => setFilter(item.id)}
                  >
                    {item.label}
                    {item.id === "all" && <span>{tasks.length}</span>}
                    {item.id === "attention" && pending > 0 && <i />}
                  </button>
                ))}
              </div>
              <div className="list-heading">
                <span>
                  {filter === "all"
                    ? "最近动态"
                    : filters.find((item) => item.id === filter)!.label}
                </span>
                <span>{filterTasks(tasks, filter, search).length} 项</span>
              </div>
              <div className="task-list">
                {filterTasks(tasks, filter, search).map(taskCard)}
              </div>
              {filterTasks(tasks, filter, search).length === 0 && (
                <div className="empty-state">
                  <Inbox size={32} />
                  <h2>这里暂时很安静</h2>
                  <p>
                    {search
                      ? "换个关键词试试。"
                      : demo
                        ? "有新的任务动态，会出现在这里。"
                        : "先创建一个任务。服务未连接时保存在本机，接通后再发送。"}
                  </p>
                  <button
                    className="text-button"
                    onClick={() => {
                      setFilter("all");
                      setSearch("");
                    }}
                  >
                    查看全部任务
                    <ArrowRight size={15} />
                  </button>
                </div>
              )}
              <p className="list-end">
                {!demo
                  ? "草稿与任务自动保存在此设备，不会自动上传。"
                  : tab === "inbox"
                    ? "不用一直盯着，有进展会告诉你。"
                    : "任务有归处，进度有回应。"}
              </p>
            </>
          ) : tab === "devices" ? (
            <section className="secondary-page">
              <button
                className="text-button settings-back"
                onClick={() => navigate("settings")}
              >
                <ArrowLeft size={16} />
                返回设置
              </button>
              <span className="eyebrow">YOUR PERSONAL CREW</span>
              <h1>各司其职。</h1>
              <p className="page-subtitle">同一个狗蛋，在不同设备上接力。</p>
              <div className="connection-summary">
                <span className="online-dot" />
                <strong>{demo ? "2 台在线" : relayState.configured ? '任务服务已配对' : "尚未连接"}</strong>
                <span>·</span>
                <span>{demo ? "1 台离线" : "预设设备信箱"}</span>
                <span className="small-demo">
                  {demo ? "演示状态" : "本地配置"}
                </span>
              </div>
              <div className="device-list">
                {devices.map((device) => (
                  <article key={device.id} className="device-card">
                    <div className="device-card-top">
                      <span
                        className={`device-icon ${device.online ? "" : "offline"}`}
                      >
                        <DeviceIcon id={device.id} size={25} />
                      </span>
                      <div>
                        <h2>{device.name}</h2>
                        <p>{device.description}</p>
                      </div>
                      <span
                        className={`device-state ${device.online ? "" : "offline"}`}
                      >
                        <span />
                        {demo ? (device.online ? "在线" : "离线") : device.id === 'win' ? '未启用' : '按任务状态确认'}
                      </span>
                    </div>
                    <code>{workspace.connection.routes[device.id]}</code>
                    <div className="device-card-bottom">
                      <span>
                        {!demo
                          ? "未检测设备在线状态；任务先留在本机"
                          : device.online
                            ? "消息和结果通过信箱流转"
                            : "任务排队保存，上线再领取"}
                      </span>
                      <button onClick={() => newTask(device.id)}>
                        发任务
                        <ArrowRight size={15} />
                      </button>
                    </div>
                  </article>
                ))}
              </div>
              <div className="info-box">
                <WifiOff size={19} />
                <div>
                  <strong>离线不等于任务丢失</strong>
                  <p>
                    {demo
                      ? "演示设备状态不代表真实设备。任务不会在任何设备运行。"
                      : "待发送与已送达分开显示。服务接通前不会自动投递；任务不会仅因重启应用而重复创建。"}
                  </p>
                </div>
              </div>
            </section>
          ) : (
            <section className="secondary-page">
              <span className="eyebrow">JUST THE ESSENTIALS</span>
              <h1>设置</h1>
              <p className="page-subtitle">简单配置，剩下的回到任务里。</p>
              <div className="settings-group">
                <button
                  className="settings-row"
                  onClick={() => navigate("devices")}
                >
                  <Monitor size={21} />
                  <span>
                    <strong>设备与信箱</strong>
                    <small>
                      {demo
                        ? "2 台在线 · 1 台离线（演示）"
                        : "手机 → Mac · Windows 尚未启用"}
                    </small>
                  </span>
                  <ChevronRight size={17} />
                </button>
              </div>
              <div className="settings-group">
                <button className="settings-row" onClick={openConnection}>
                  <Plug size={21} />
                  <span>
                    <strong>任务服务连接</strong>
                    <small>
                      {relayState.url || workspace.connection.url || "导入手机设备凭据以连接"}
                    </small>
                  </span>
                  <ChevronRight size={17} />
                </button>
              </div>
              <section className="settings-group settings-sync">
                <div className="settings-row">
                  <RefreshCw size={21} />
                  <span>
                    <strong>同步</strong>
                    <small>
                      {demo ? `上次模拟同步 · ${lastSync}` : "尚未接入同步服务"}
                    </small>
                  </span>
                  <span className="small-demo">{demo ? "演示" : "未连接"}</span>
                </div>
                <p>
                  仅同步明确指定的共享内容，不展示记忆正文。当前不会读取或上传任何文件。
                </p>
                <button
                  className="secondary full"
                  disabled={syncing}
                  onClick={() =>
                    demo
                      ? setSyncing(true)
                      : setToast("同步接口已预留，等待后续服务端接通")
                  }
                >
                  <RefreshCw size={16} className={syncing ? "spin" : ""} />
                  {syncing
                    ? "模拟同步中…"
                    : demo
                      ? "模拟立即同步"
                      : "立即同步 · 待接入"}
                </button>
              </section>
              <div className="settings-group">
                <button
                  className="settings-row"
                  onClick={() => void switchMode(demo ? "local" : "demo")}
                >
                  <Smartphone size={21} />
                  <span>
                    <strong>{demo ? "返回本地工作台" : "体验演示沙盒"}</strong>
                    <small>演示数据独立保存，不影响真实待发送任务</small>
                  </span>
                  <ChevronRight size={17} />
                </button>
                <button
                  className="settings-row"
                  onClick={() => setSheet("about")}
                >
                  <Info size={21} />
                  <span>
                    <strong>关于与使用说明</strong>
                    <small>DogO 0.2.0 · 任务联网版</small>
                  </span>
                  <ChevronRight size={17} />
                </button>
              </div>
              <p className="footnote">
                {native ? "Android 本地应用" : "浏览器预览"} ·
                数据保存在当前设备
              </p>
            </section>
          )}
        </main>

        {!selected && (tab === "inbox" || tab === "tasks") && (
          <div className="compose-dock">
            <button className="compose-button" onClick={() => newTask()}>
              <span className="compose-plus">
                <Plus size={20} />
              </span>
              <span>
                给狗蛋一个任务
                <small>
                  {workspace.drafts[mode].title ||
                  workspace.drafts[mode].description
                    ? "有一份未完成草稿，点此继续。"
                    : demo
                      ? "想好了就发，剩下的交给设备。"
                      : "先保存在手机，连接服务后再发送。"}
                </small>
              </span>
              <ArrowRight size={19} />
            </button>
          </div>
        )}
        <nav className="bottom-nav" aria-label="主导航">
          {tabs.map((item) => (
            <button
              key={item.id}
              className={activeTab === item.id ? "active" : ""}
              aria-current={activeTab === item.id ? "page" : undefined}
              onClick={() => navigate(item.id)}
            >
              <span>
                <item.icon
                  size={21}
                  strokeWidth={activeTab === item.id ? 2.2 : 1.7}
                />
                {item.id === "inbox" && unread > 0 && <i />}
              </span>
              {item.label}
            </button>
          ))}
        </nav>
        {toast && (
          <div className="toast" role="status">
            <CircleCheck size={18} />
            <span>{toast}</span>
            {toastTask && toast.startsWith("新结果：") && (
              <button onClick={() => openTask(toastTask)}>查看</button>
            )}
            <button aria-label="关闭提示" onClick={() => setToast(null)}>
              <X size={15} />
            </button>
          </div>
        )}
      </div>

      {sheet === "compose" && (
        <Sheet title="交给狗蛋" onClose={() => setSheet(null)}>
          <p className="sheet-subtitle">告诉它做什么，再选一台合适的设备。</p>
          {storageError && (
            <p className="form-error" role="alert">
              {storageError}
            </p>
          )}
          <form onSubmit={submitTask}>
            <label className="field-label" htmlFor="task-title">
              任务标题
            </label>
            <input
              id="task-title"
              className="text-input"
              placeholder="例如：检查项目里的登录问题"
              value={title}
              onChange={(event) =>
                saveDraft({
                  title: event.target.value,
                  description,
                  device: composeDevice,
                })
              }
              maxLength={100}
              required
            />
            <label className="field-label" htmlFor="task-description">
              具体说明
            </label>
            <textarea
              id="task-description"
              placeholder="需要做什么？在哪个项目？希望收到什么结果？"
              value={description}
              onChange={(event) =>
                saveDraft({
                  title,
                  description: event.target.value,
                  device: composeDevice,
                })
              }
              maxLength={4000}
              required
              rows={4}
            />
            <fieldset className="device-picker">
              <legend>交给哪台设备</legend>
              {devices.map((device) => (
                <label
                  key={device.id}
                  className={composeDevice === device.id ? "selected" : ""}
                >
                  <input
                    type="radio"
                    name="device"
                    value={device.id}
                    checked={composeDevice === device.id}
                    onChange={() =>
                      saveDraft({ title, description, device: device.id })
                    }
                  />
                  <DeviceIcon id={device.id} size={21} />
                  <span>
                    <strong>{device.name}</strong>
                    <small>
                      {!demo
                        ? "未连接 · 保存到本机"
                        : device.online
                          ? "在线 · 可接收（演示）"
                          : "离线 · 排队等待（演示）"}
                    </small>
                  </span>
                  <span className="radio-indicator">
                    {composeDevice === device.id && <Check size={12} />}
                  </span>
                </label>
              ))}
            </fieldset>
            <div className="compose-destination">
              <span>目标信箱</span>
              <code>{workspace.connection.routes[composeDevice]}</code>
            </div>
            {(composeDevice === "win" || !demo) && (
              <p className="inline-warning">
                <WifiOff size={15} />
                {demo
                  ? "演示设备离线，任务先保留。"
                  : "先保存到待发送列表，检查内容后点击发送。"}
              </p>
            )}
            <button
              className="primary full send-button"
              disabled={saving || !title.trim() || !description.trim()}
              type="submit"
            >
              {saving ? "正在保存…" : demo ? "加入演示信箱" : "保存到待发送"}
              <Send size={17} />
            </button>
            <p className="footnote">
              草稿自动保存，关闭应用后仍可继续。
              {demo
                ? "这是独立演示，不会真实发送。"
                : "保存成功后再退出，不需要重复创建。"}
            </p>
          </form>
        </Sheet>
      )}
      {sheet === "notifications" && (
        <Sheet title="新消息" onClose={() => setSheet(null)}>
          <p className="sheet-subtitle">需要你看一眼的，都在这里。</p>
          {tasks.filter((task) => task.unread).map(taskCard)}
          {unread === 0 && (
            <div className="empty-state">
              <CheckCheck size={32} />
              <h2>都看过了</h2>
              <p>有新进展会再提醒你。</p>
            </div>
          )}
          {unread > 0 && (
            <button
              className="secondary full"
              onClick={async () => {
                const saved = await setTasks((current) =>
                  current.map((task) => ({ ...task, unread: false })),
                );
                if (saved) setToast("消息已全部标为已读");
              }}
            >
              全部标为已读
              <CheckCheck size={16} />
            </button>
          )}
        </Sheet>
      )}
      {sheet === "preview" && (
        <Sheet
          title={demo ? "演示工具" : "本地模式"}
          onClose={() => setSheet(null)}
        >
          <p className="sheet-subtitle">
            {demo
              ? "演示数据与真实任务分开。可以模拟任务返回；不调用任何 Agent。"
              : "任务与草稿保存在本机。配对后由你确认发送，结果在前台自动刷新；演示任务永不发送。"}
          </p>
          <button className="preview-action" onClick={simulateResult}>
            <Bell size={20} />
            <span>
              <strong>{demo ? "模拟收到执行结果" : "进入演示沙盒"}</strong>
              <small>
                {demo
                  ? "完成一条模拟任务，查看结果"
                  : "体验发任务、设备接单与结果阅读"}
              </small>
            </span>
            <ChevronRight size={18} />
          </button>
          {demo && (
            <button
              className="preview-action"
              onClick={async () => {
                if (!(await setTasks(initialTasks()))) return;
                navigate("inbox");
                setSheet(null);
                setToast("仅演示数据已重置，真实任务未改动");
              }}
            >
              <RefreshCw size={20} />
              <span>
                <strong>重置全部演示数据</strong>
                <small>恢复初始任务和未读状态</small>
              </span>
              <ChevronRight size={18} />
            </button>
          )}
          {demo && (
            <button
              className="secondary full"
              onClick={() => void switchMode("local")}
            >
              返回本地工作台
            </button>
          )}
          <div className="info-box">
            <ShieldCheck size={18} />
            <p>
              当前使用前台刷新，未接入系统后台推送或记忆同步。关闭手机应用不影响 Mac 已领取的任务，重新打开后读取结果。
            </p>
          </div>
        </Sheet>
      )}
      {sheet === "connection" && (
        <Sheet title="任务服务连接" onClose={() => setSheet(null)}>
          <p className="sheet-subtitle">
            导入 phone.json 配对此手机。凭据由 Android Keystore 加密保存，不进入网页或 APK；任务需逐条确认发送，结果在前台自动刷新。
          </p>
          <button className="primary full" disabled={!native || demo || networkBusy} onClick={() => void importPairing()}>导入手机设备凭据</button>
          <button className="secondary full" disabled={!relayState.configured || networkBusy || demo} onClick={() => void networkAction(() => relay.refresh())}>检查连接并刷新结果</button>
          <p className="footnote">{relayState.configured ? `已绑定：${relayState.url} · phone` : '尚未配对。浏览器预览不会接收长期令牌。'}</p>
          {relayError && <p role="alert" className="form-error">{relayError}</p>}
          <form onSubmit={saveConnection}>
            {storageError && (
              <p className="form-error" role="alert">
                {storageError}
              </p>
            )}
            <label className="field-label" htmlFor="relay-url">
              服务地址（可留空）
            </label>
            <input
              id="relay-url"
              className="text-input"
              type="url"
              placeholder="https://relay.example.com"
              value={connection.url}
              autoCapitalize="none"
              spellCheck={false}
              onChange={(event) =>
                setConnection({ ...connection, url: event.target.value })
              }
            />
            {devices.map((device) => (
              <div key={device.id}>
                <label className="field-label" htmlFor={`route-${device.id}`}>
                  {device.name} 信箱
                </label>
                <input
                  id={`route-${device.id}`}
                  className="text-input"
                  value={connection.routes[device.id]}
                  maxLength={72}
                  autoCapitalize="none"
                  spellCheck={false}
                  required
                  onChange={(event) =>
                    setConnection({
                      ...connection,
                      routes: {
                        ...connection.routes,
                        [device.id]: event.target.value,
                      },
                    })
                  }
                />
              </div>
            ))}
            {connectionError && (
              <p className="form-error" role="alert">
                {connectionError}
              </p>
            )}
            <p className="footnote">
              修改信箱只影响之后新建的任务，已有任务目标不变。实际服务由凭据文件绑定；下方仅保存路径预配置，不会更换凭据或自动发送。当前服务器只启用手机到 Mac。
            </p>
            <button className="primary full" type="submit">
              保存预配置，不连接
            </button>
          </form>
        </Sheet>
      )}
      {sheet === "retract" && (
        <Sheet title="撤回待发送任务？" onClose={() => setSheet(null)}>
          <p className="sheet-subtitle">
            此任务还没有离开手机。撤回后不再等待发送，历史记录保留；不涉及取消远端正在运行的任务。
          </p>
          <div className="button-row">
            <button className="secondary" onClick={() => setSheet(null)}>
              继续保留
            </button>
            <button className="primary" onClick={() => void retractSelected()}>
              确认撤回
            </button>
          </div>
        </Sheet>
      )}
      {sheet === "about" && (
        <Sheet title="DogO · 狗蛋" onClose={() => setSheet(null)}>
          <p className="sheet-subtitle">0.2.0 · Android 任务联网版</p>
          <div className="help-copy">
            <h3>现在可以做什么</h3>
            <p>
              保存任务与草稿、配对后发送到 Mac、前台刷新进度和结果、搜索记录、复制及系统分享。
            </p>
            <h3>后续接通什么</h3>
            <p>
              系统后台推送、记忆同步及更多设备能力仍待接入。Mac 需要保持 DogO 运行并确认执行。
            </p>
            <h3>数据在哪里</h3>
            <p>
              草稿和本地记录在应用私有存储中；确认发送的任务与返回结果也保存在你的中转服务器。演示任务永不上传。卸载或清除数据会删除本地记录，重要内容请先分享保存。
            </p>
            <h3>权限与隐私</h3>
            <p>
              不内置账号或令牌，不采集统计追踪，不申请通讯录、定位、屏幕或通知权限。导入凭据只读取你通过系统文件选择器选中的文件，令牌由 Android Keystore 加密保存。
            </p>
          </div>
        </Sheet>
      )}
    </div>
  );
}
