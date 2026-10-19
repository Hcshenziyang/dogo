import type { Task } from "./model.ts";

/** Task protocol boundary. Native adapters own credentials and networking. */
export interface TaskGateway {
  publish(input: {
    requestId: string;
    mailbox: string;
    title: string;
    instructions: string;
  }): Promise<{ id: string }>;
  read(
    taskId: string,
  ): Promise<{
    status: "queued" | "running" | "succeeded" | "failed";
    progress: string | null;
    result: string | null;
  }>;
}
export interface MemorySyncGateway {
  sync(): Promise<{ completedAt: number }>;
}
export function toPublishInput(task: Task) {
  if (task.status !== "outbox" || !task.requestId || !task.mailbox)
    throw new Error("只有真实待发送任务可以投递");
  return {
    requestId: task.requestId,
    mailbox: task.mailbox,
    title: task.title,
    instructions: task.description,
  };
}
export const unconfiguredGateway: TaskGateway = {
  async publish() {
    throw new Error("尚未连接任务服务，任务仍保存在此手机");
  },
  async read() {
    throw new Error("尚未连接任务服务，无法读取远端结果");
  },
};
