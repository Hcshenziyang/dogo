import { randomUUID } from "node:crypto";
import { z } from "zod";
import { Store } from "./store.mjs";
import { listWorkspace, normalizeWorkspace } from "./workspace.mjs";
import { Relay } from './relay.mjs';
import { DshBackend } from './dsh.mjs';
import { HubClient } from './hub.mjs';
import { PersonalMemory } from './memory.mjs';
import { Capabilities } from './capabilities.mjs';

const settingsSchema = z
  .object({
    endpoint: z
      .string()
      .url()
      .refine((value) => {
        const u = new URL(value);
        return (
          u.protocol === "http:" &&
          ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname) &&
          !u.username &&
          !u.password &&
          !u.search &&
          !u.hash
        );
      }, "当前只支持本机 HTTP 模型地址，不接受凭据或外部地址"),
    model: z.string().trim().max(160),
    contextWindow: z.number().int().min(4096).max(131072),
    maxTokens: z.number().int().min(256).max(32768),
    relayUrl: z
      .union([
        z.literal(""),
        z
          .string()
          .url()
          .refine((value) => {
            const u = new URL(value);
            return (
              ["http:", "https:"].includes(u.protocol) &&
              !u.username &&
              !u.password &&
              !u.search &&
              !u.hash
            );
          }, "中转地址不能包含凭据、查询参数或片段"),
      ])
      .default(""),
  })
  .refine(
    (v) => v.maxTokens < v.contextWindow / 2,
    "最大输出需小于上下文的一半",
  );
const createSchema = z.object({
  kind: z.enum(["inspect", "analysis"]),
  prompt: z.string().trim().min(1).max(64000),
  workspaceId: z.string().optional(),
});

export class Engine {
  constructor(directory, onChange = () => {}, runModel) {
    this.directory = directory;
    this.store = new Store(directory);
    this.onChange = onChange;
    this.runModel = runModel;
    this.workspaces = new Map();
    this.active = new Map();
    this.relay = new Relay(this);
    this.dsh = new DshBackend(directory, () => this.changed());
    this.hub = new HubClient(this);
    this.memory = new PersonalMemory(this);
    this.capabilities = new Capabilities(this);
    this.dsh.beforeStart = () => this.capabilities.start();
  }
  snapshot() {
    return {
      tasks: this.store.tasks(),
      settings: this.store.settings(),
      workspaces: [...this.workspaces].map(([id, folder]) => ({
        id,
        path: folder,
      })),
      runtime: "ready",
      relay: this.relay.snapshot(),
      backend: this.dsh.snapshot(),
      hub: this.hub?.snapshot(),
      memory: this.memory?.snapshot(),
      readiness: this.readiness,
      capabilities: this.capabilities?.snapshot(),
    };
  }
  changed() {
    this.onChange(this.snapshot());
  }
  async executionStatus() {
    const local = this.active.size + (this.memory.active?.size ?? 0) + (this.capabilities.active?.size ?? 0);
    if (this.dsh.state === 'stopped') return { active: local, unknown: false };
    try {
      const health = await this.dsh.request('/health');
      if (!Number.isInteger(health.activeAgents)) throw new Error('Unknown activity');
      return { active: Math.max(local, health.activeAgents), unknown: false };
    } catch { return { active: local, unknown: true }; }
  }
  async authorizeWorkspace(folder) {
    if (this.closing) throw new Error("运行服务正在退出");
    const root = await normalizeWorkspace(folder);
    if (this.closing) throw new Error("运行服务正在退出");
    const id = randomUUID();
    this.workspaces.set(id, root);
    this.changed();
    return { id, path: root };
  }
  configure(input) {
    if (this.closing) throw new Error("运行服务正在退出");
    if (this.active.size) throw new Error("请在任务结束后修改配置");
    this.store.configure(settingsSchema.parse(input));
    this.changed();
  }
  validateCreate(input) {
    if (this.closing) throw new Error("运行服务正在退出");
    const value = createSchema.parse(input);
    const workspace = value.workspaceId
      ? this.workspaces.get(value.workspaceId)
      : undefined;
    if (value.workspaceId && !workspace)
      throw new Error("目录授权已过期，请重新选择");
    if (value.kind === "inspect" && !workspace)
      throw new Error("请先选择要检查的文件夹");
    if (value.kind === "analysis" && !this.store.settings().model)
      throw new Error("先在设置中填写本地模型 ID");
    if (this.active.size)
      throw new Error("当前已有任务执行中，请完成或停止后再提交");
    return { value, workspace };
  }
  create(input, origin) {
    const { value, workspace } = this.validateCreate(input);
    const now = new Date().toISOString();
    const task = {
      id: origin?.id ?? randomUUID(),
      kind: value.kind,
      title: value.prompt.slice(0, 56),
      prompt: value.prompt,
      workspace,
      status: "queued",
      output: "",
      error: "",
      logs: [],
      turns: [],
      createdAt: now,
      updatedAt: now,
      source: origin?.source ?? "本机",
      remoteId: origin?.remoteId,
      engine: value.kind === 'analysis' ? 'dsh' : undefined,
    };
    this.store.save(task);
    this.start(task);
    return task.id;
  }
  followup(id, prompt) {
    if (this.closing) throw new Error("运行服务正在退出");
    const task = this.store.get(z.string().uuid().parse(id));
    if (task.remoteId) throw new Error('远端任务的结果已绑定原任务，请创建新任务继续');
    if (task.sessionFile && !task.dshSessionId) throw new Error('旧 Pi 会话保留查看，请创建新的 DSH 任务');
    if (
      task.kind !== "analysis" ||
      task.status !== "succeeded" ||
      this.active.size
    )
      throw new Error("仅已完成的分析任务可以继续对话");
    // Folder grants do not survive runtime restarts; do not silently re-authorize old paths.
    if (
      task.workspace &&
      ![...this.workspaces.values()].includes(task.workspace)
    )
      throw new Error("本次启动尚未授权原目录，请重新选择相同文件夹");
    task.turns.push({ prompt: task.prompt, output: task.output });
    task.prompt = z.string().trim().min(1).max(16000).parse(prompt);
    task.output = "";
    task.error = "";
    task.status = "queued";
    this.store.save(task);
    this.start(task);
    return task.id;
  }
  start(task) {
    const controller = new AbortController();
    const entry = { controller, done: null };
    this.active.set(task.id, entry);
    const update = () => {
      task.updatedAt = new Date().toISOString();
      this.store.save(task);
      this.changed();
    };
    const log = (message) => {
      task.logs.push({ at: new Date().toISOString(), message });
      update();
    };
    task.status = "running";
    update();
    entry.done = (async () => {
      try {
        log(
          task.kind === "inspect"
            ? "开始只读目录检查，不调用模型"
            : "连接 DSH 与已配置的本地模型（只读授权）",
        );
        if (task.kind === "inspect") {
          const tree = await listWorkspace(task.workspace, controller.signal);
          controller.signal.throwIfAborted();
          task.output = `目录检查完成\n\n${task.workspace}\n\n${tree.files.length} 个可见条目${tree.truncated ? "（已达到深度或数量限制）" : ""}\n\n${tree.files.join("\n") || "此目录没有可展示的文件。"}\n\n已跳过隐藏文件、符号链接、依赖及构建目录。不读取文件内容、不修改文件。`;
        } else {
          const run = this.runModel ?? this.dsh.run.bind(this.dsh);
          let lastSave = 0;
          await run({
            task,
            settings: this.store.settings(),
            directory: this.directory,
            signal: controller.signal,
            log,
            sessionReady: (sessionId) => {
              task.dshSessionId = sessionId;
              update();
            },
            delta: (text) => {
              task.output += text;
              if (Date.now() - lastSave > 100) {
                lastSave = Date.now();
                update();
              }
            },
          });
          controller.signal.throwIfAborted();
        }
        task.status = "succeeded";
        log("执行完成，结果已保存到本机");
      } catch (error) {
        task.status = controller.signal.aborted ? "cancelled" : "failed";
        task.error = controller.signal.aborted
          ? "已停止。部分输出保留；未自动重试。"
          : String(error.message ?? error).slice(0, 1500);
      } finally {
        this.active.delete(task.id);
        update();
      }
    })();
  }
  async cancel(id) {
    const entry = this.active.get(id);
    if (!entry) throw new Error("此任务已不在运行");
    entry.controller.abort();
    await entry.done;
  }
  async close() {
    if (this.closing) return this.closing;
    this.closing = (async () => {
      for (const entry of this.active.values()) entry.controller.abort();
      await Promise.all([...this.active.values()].map((v) => v.done));
      await this.memory.close();
      await this.relay.close();
      await this.hub.close();
      await this.capabilities.close();
      await this.dsh.close();
      this.store.close();
    })();
    return this.closing;
  }
}
