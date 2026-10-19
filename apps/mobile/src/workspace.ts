import { z } from "zod";
import { initialTasks } from "./model.ts";
import type { DeviceId, Task } from "./model.ts";

export type Mode = "local" | "demo";
const deviceId = z.enum(["mac", "win", "phone"]);
const route = z
  .string()
  .regex(
    /^\/tasks\/[a-z0-9][a-z0-9_-]{0,63}$/,
    "信箱应为 /tasks/mac 这样的路径",
  );
export const connectionSchema = z.object({
  url: z
    .string()
    .max(300)
    .refine((value) => {
      if (!value) return true;
      try {
        const url = new URL(value);
        return (
          url.protocol === "https:" &&
          !url.username &&
          !url.password &&
          !url.search &&
          !url.hash &&
          url.pathname === "/"
        );
      } catch {
        return false;
      }
    }, "请填写 HTTPS 服务地址，不包含路径、账号或查询参数"),
  routes: z
    .object({ mac: route, win: route, phone: route })
    .refine(
      (value) => new Set(Object.values(value)).size === 3,
      "三个信箱不能重复",
    ),
});
export type Connection = z.infer<typeof connectionSchema>;
export const draftSchema = z.object({
  title: z.string().max(100),
  description: z.string().max(4000),
  device: deviceId,
});
export type Draft = z.infer<typeof draftSchema>;
const taskSchema = z.object({
  id: z.string().min(1).max(100),
  title: z.string().min(1).max(300),
  description: z.string().max(64000),
  device: deviceId,
  status: z.enum([
    "outbox",
    "approval",
    "running",
    "queued",
    "succeeded",
    "failed",
    "cancelled",
  ]),
  time: z.string().max(100),
  unread: z.boolean(),
  category: z.string().max(100),
  result: z.array(z.string().max(128000)).max(100).optional(),
  activity: z
    .array(z.object({ label: z.string().max(4000), time: z.string().max(100) }))
    .max(500),
  requestId: z.string().max(100).optional(),
  mailbox: route.optional(),
  createdAt: z.number().optional(),
  remoteId: z.string().uuid().optional(),
  relayOrigin: z.string().url().optional(),
  remoteUpdatedAt: z.number().optional(),
  sendAttempted: z.boolean().optional(),
});
export const workspaceSchema = z.object({
  version: z.literal(1),
  mode: z.enum(["local", "demo"]),
  localTasks: z.array(taskSchema).max(500),
  demoTasks: z.array(taskSchema).max(500),
  drafts: z.object({ local: draftSchema, demo: draftSchema }),
  connection: connectionSchema,
});
export type Workspace = z.infer<typeof workspaceSchema>;
export const emptyDraft = (): Draft => ({
  title: "",
  description: "",
  device: "mac",
});
export function newWorkspace(): Workspace {
  return {
    version: 1,
    mode: "local",
    localTasks: [],
    demoTasks: initialTasks(),
    drafts: { local: emptyDraft(), demo: emptyDraft() },
    connection: {
      url: "",
      routes: { mac: "/tasks/mac", win: "/tasks/win", phone: "/tasks/phone" },
    },
  };
}
export function createOutboxTask(draft: Draft, connection: Connection): Task {
  const input = draftSchema.parse(draft);
  if (!input.title.trim() || !input.description.trim())
    throw new Error("请填写任务标题和具体说明");
  const id = crypto.randomUUID();
  return {
    id,
    requestId: id,
    mailbox: connection.routes[input.device],
    createdAt: Date.now(),
    title: input.title.trim(),
    description: input.description.trim(),
    device: input.device,
    status: "outbox",
    time: "刚刚",
    unread: false,
    category: "本地待发送",
    activity: [
      {
        label: "已保存到此手机，尚未发送或执行",
        time: new Date().toLocaleString("zh-CN"),
      },
    ],
  };
}
export function retractOutbox(tasks: Task[], id: string): Task[] {
  return tasks.map((task) =>
    task.id === id && task.status === "outbox" && !task.sendAttempted
      ? {
          ...task,
          status: "cancelled",
          category: "本地记录",
          activity: [
            ...task.activity,
            {
              label: "已撤回本地待发送任务；没有向设备发送",
              time: new Date().toLocaleString("zh-CN"),
            },
          ],
        }
      : task,
  );
}
export function displayTime(task: Task): string {
  if (!task.createdAt) return task.time;
  return new Date(task.createdAt).toLocaleString("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export interface KeyValueStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
}
const KEY = "dogo.workspace.v1";
const BACKUP = `${KEY}.backup`;
const MAX_BYTES = 8 * 1024 * 1024;

/** Durable-first updates: a failed disk write never becomes a successful UI action. */
export class WorkspaceRepository {
  private state: Workspace = newWorkspace();
  private ready = false;
  private queue: Promise<unknown> = Promise.resolve();
  private listeners = new Set<() => void>();
  private storage: KeyValueStore;
  recovered = false;
  constructor(storage: KeyValueStore) {
    this.storage = storage;
  }
  snapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  async load() {
    const raw = await this.storage.get(KEY);
    if (raw === null) {
      this.state = newWorkspace();
    } else {
      try {
        this.state = workspaceSchema.parse(JSON.parse(raw));
      } catch {
        const backup = await this.storage.get(BACKUP);
        try {
          if (!backup) throw new Error("No backup");
          this.state = workspaceSchema.parse(JSON.parse(backup));
          this.recovered = true;
        } catch {
          throw new Error(
            "本地数据无法读取，已保留原始数据。请勿卸载或清除应用数据，可重试或联系开发者恢复。",
          );
        }
      }
    }
    this.ready = true;
    return this.state;
  }
  update(change: (state: Workspace) => Workspace): Promise<void> {
    const run = this.queue.then(async () => {
      if (!this.ready) throw new Error("本地数据尚未加载");
      const next = workspaceSchema.parse(change(structuredClone(this.state)));
      const serialized = JSON.stringify(next);
      if (new TextEncoder().encode(serialized).length > MAX_BYTES)
        throw new Error("本地记录已达容量上限，当前操作未保存");
      await this.storage.set(BACKUP, JSON.stringify(this.state));
      await this.storage.set(KEY, serialized);
      this.state = next;
      this.listeners.forEach((listener) => listener());
    });
    this.queue = run.catch(() => {});
    return run;
  }
  async flush() {
    await this.queue;
  }
}

export function taskText(task: Task): string {
  return [
    task.title,
    task.description,
    task.mailbox ? `目标信箱：${task.mailbox}` : "",
    ...(task.result ? ["执行结果", ...task.result] : []),
  ]
    .filter(Boolean)
    .join("\n\n");
}
