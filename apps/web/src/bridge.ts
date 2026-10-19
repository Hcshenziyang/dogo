export type TaskStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "interrupted";
export interface Task {
  id: string;
  title: string;
  prompt: string;
  kind: "inspect" | "analysis";
  status: TaskStatus;
  workspace?: string;
  output: string;
  error: string;
  source: string;
  remoteId?: string;
  engine?: 'dsh';
  logs: { at: string; message: string }[];
  turns: { prompt: string; output: string }[];
  createdAt: string;
  updatedAt: string;
}
export interface Settings {
  endpoint: string;
  model: string;
  contextWindow: number;
  maxTokens: number;
  relayUrl: string;
}
export interface Workspace {
  id: string;
  path: string;
}
export interface Snapshot {
  readiness?: { at: number; checks: { id: string; ok: boolean; message: string }[] };
  capabilities?: { policy: { computer: boolean; codex: boolean; sshHosts: string[] }; active: number };
  memory?: { enabled: boolean; folder: string; at: number | null; error: string; syncing: boolean; conflicts: { id: string; path: string; status: string }[] };
  hub?: { items: import('@dogo/hub-ui/client').HubItem[]; policy: { autoExecute: boolean }; projects: { id: string; path: string; name: string; summary: string; published: boolean; executionAllowed: boolean; available: boolean }[]; error: string; syncedAt: number | null };
  tasks: Task[];
  settings: Settings;
  workspaces: Workspace[];
  runtime: "ready" | "offline";
  backend?: { state: 'stopped' | 'starting' | 'ready' | 'failed'; error: string; version: string };
  relay?: {
    configured: boolean; connected: boolean; url: string; device: string; error: string;
    inbox: { id: string; title: string; instructions: string; sender: string; status: string }[];
    deliveries: { localId: string; returned: boolean; error: string }[];
  };
}
export interface CreateTask {
  kind: "inspect" | "analysis";
  prompt: string;
  workspaceId?: string;
}
export interface WorkspaceViewState {
  phase: 'idle' | 'loading' | 'ready' | 'error'; message: string; visible: boolean;
}
export interface Bridge {
  prepare(): Promise<unknown>;
  capabilitiesConfigure(value: { computer: boolean; codex: boolean; sshHosts: string[] }): Promise<unknown>;
  account(value: import('@dogo/hub-ui/account').AccountInput): Promise<any>;
  saveArtifact(value: { origin: string; id: string; name: string }): Promise<unknown>;
  workspaceSnapshot(): Promise<WorkspaceViewState>;
  workspaceShow(value: { visible: boolean }): Promise<WorkspaceViewState>;
  workspaceReload(): Promise<WorkspaceViewState>;
  onWorkspace(callback: (value: WorkspaceViewState) => void): () => void;
  onOpenWorkspace(callback: () => void): () => void;
  loginItem(value?: { enabled: boolean }): Promise<{ openAtLogin: boolean; supported: boolean }>;
  memoryConfigure(value: { enabled: boolean }): Promise<unknown>;
  memorySync(): Promise<unknown>;
  memory(value: { op: string; args?: Record<string, unknown> }): Promise<any>;
  openMemory(): Promise<unknown>;
  hubAction(value: { op: string; args: Record<string, unknown> }): Promise<any>;
  remotePolicy(value: { autoExecute: boolean }): Promise<unknown>;
  registerProject(): Promise<unknown>;
  updateProject(value: { id: string; name: string; summary: string; published: boolean; executionAllowed: boolean }): Promise<unknown>;
  hubCache(value: { value?: string }): Promise<any>;
  openDsh(): Promise<unknown>;
  importRelay(): Promise<unknown>;
  refreshRelay(): Promise<unknown>;
  acceptRemote(input: { id: string; kind: 'inspect' | 'analysis'; workspaceId?: string }): Promise<string>;
  copyResult(id: string): Promise<unknown>;
  snapshot(): Promise<Snapshot>;
  configure(settings: Settings): Promise<unknown>;
  create(task: CreateTask): Promise<string>;
  followup(value: { id: string; prompt: string }): Promise<string>;
  cancel(id: string): Promise<unknown>;
  chooseWorkspace(): Promise<Workspace | null>;
  subscribe(callback: (snapshot: Snapshot) => void): () => void;
}
declare global {
  interface Window {
    dogo?: Bridge;
  }
}
export const isPreview = !window.dogo;
const time = new Date().toISOString();
const demo: Snapshot = {
  runtime: "ready",
  settings: {
    endpoint: "http://127.0.0.1:8000/v1",
    model: "",
    contextWindow: 32768,
    maxTokens: 4096,
    relayUrl: "",
  },
  workspaces: [],
  tasks: [
    {
      id: "example",
      title: "检查工作目录，整理文件结构",
      prompt: "检查工作目录，整理文件结构",
      kind: "inspect",
      status: "succeeded",
      workspace: "/演示/hello-dogo",
      output:
        "这是界面演示结果，不是本机执行记录。\n\nhello-dogo/\n  src/\n    app.ts\n  package.json\n  README.md\n\n原生桌面版会对你选择的目录执行真实的只读检查。",
      error: "",
      source: "演示",
      logs: [
        { at: time, message: "示例：目录检查完成" },
        { at: time, message: "示例：结果已保存" },
      ],
      turns: [],
      createdAt: time,
      updatedAt: time,
    },
  ],
};
const listeners = new Set<(s: Snapshot) => void>();
const emit = () => {
  for (const cb of listeners) cb(structuredClone(demo));
};
const preview: Bridge = {
  account: async () => ({ configured: false, authenticated: false, url: '', canSetup: false }),
  saveArtifact: async () => { throw new Error('开发预览不下载附件'); },
  workspaceSnapshot: async () => ({ phase: 'idle', message: '', visible: false }),
  workspaceShow: async ({ visible }) => ({ phase: 'idle', message: '请在 DogO 桌面应用打开本机 DSH 工作区。浏览器预览不会启动执行器。', visible }),
  workspaceReload: async () => ({ phase: 'idle', message: '浏览器仅提供界面预览。', visible: true }),
  onWorkspace: () => () => {}, onOpenWorkspace: () => () => {},
  loginItem: async () => ({ openAtLogin: false, supported: false }),
  memoryConfigure: async () => {}, memorySync: async () => {}, memory: async () => { throw new Error('请在已登录的 DogO 中管理记忆'); }, openMemory: async () => {}, prepare: async () => {}, capabilitiesConfigure: async () => {},
  hubAction: async () => { throw new Error('浏览器预览不连接真实设备'); },
  remotePolicy: async () => {}, registerProject: async () => {}, updateProject: async () => {}, hubCache: async () => null,
  openDsh: async () => { throw new Error('请在原生桌面版启动 DSH 后端'); },
  importRelay: async () => { throw new Error('请在原生桌面版导入设备文件，网页不接收长期凭据'); },
  refreshRelay: async () => {},
  acceptRemote: async () => { throw new Error('浏览器预览不会执行远端任务'); },
  copyResult: async (id) => {
    const task = demo.tasks.find((t) => t.id === id);
    if (task) await navigator.clipboard.writeText(task.output);
  },
  snapshot: async () => structuredClone(demo),
  configure: async (settings) => {
    demo.settings = settings;
    emit();
  },
  chooseWorkspace: async () => {
    const workspace = { id: "demo-workspace", path: "/演示/hello-dogo" };
    demo.workspaces = [workspace];
    emit();
    return workspace;
  },
  create: async (value) => {
    if (value.kind === "inspect" && !value.workspaceId)
      throw new Error("请先选择演示目录");
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    demo.tasks.unshift({
      id,
      title: value.prompt.slice(0, 56),
      prompt: value.prompt,
      kind: value.kind,
      status: "running",
      workspace: value.workspaceId ? "/演示/hello-dogo" : undefined,
      output: "",
      error: "",
      source: "演示",
      logs: [{ at: now, message: "模拟任务开始，未调用本机工具或模型" }],
      turns: [],
      createdAt: now,
      updatedAt: now,
    });
    emit();
    setTimeout(() => {
      const task = demo.tasks.find((t) => t.id === id)!;
      if (task.status !== "running") return;
      task.status = "succeeded";
      task.output =
        "演示流程已完成。\n\n桌面版将在本机保存真实任务、执行记录和结果。浏览器预览不读取你的文件，也不连接任何模型或服务器。";
      task.logs.push({
        at: new Date().toISOString(),
        message: "模拟结果已返回",
      });
      emit();
    }, 1500);
    return id;
  },
  followup: async ({ prompt }) => preview.create({ kind: "analysis", prompt }),
  cancel: async (id) => {
    const task = demo.tasks.find((t) => t.id === id);
    if (task) {
      task.status = "cancelled";
      task.error = "演示任务已停止";
      emit();
    }
  },
  subscribe: (callback) => {
    listeners.add(callback);
    return () => {
      listeners.delete(callback);
    };
  },
};
export const bridge = window.dogo ?? preview;
