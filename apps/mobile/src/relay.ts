import { z } from 'zod';
import { toPublishInput } from './gateway.ts';
import type { WorkspaceRepository } from './workspace.ts';

export type RelayStatus = { configured: boolean; url: string; device: string };
export interface NativeRelayTransport {
  status(): Promise<RelayStatus>;
  importPairing(): Promise<RelayStatus>;
  identity(): Promise<{ device: string; services: string[] }>;
  publish(input: { origin: string; input: ReturnType<typeof toPublishInput> }): Promise<unknown>;
  read(input: { origin: string; id: string }): Promise<unknown>;
}
const remoteSchema = z.object({
  id: z.string().uuid(), requestId: z.string(), mailbox: z.string(), sender: z.literal('phone'),
  status: z.enum(['queued', 'running', 'succeeded', 'failed']),
  progress: z.string().max(4000).nullable(), result: z.string().max(128000).nullable(), updatedAt: z.number(),
});

export class RelaySession {
  private queue: Promise<unknown> = Promise.resolve();
  private repository: WorkspaceRepository;
  readonly native: NativeRelayTransport;
  constructor(repository: WorkspaceRepository, native: NativeRelayTransport) { this.repository = repository; this.native = native; }
  private exclusive<T>(run: () => Promise<T>): Promise<T> {
    const result = this.queue.then(run); this.queue = result.catch(() => {}); return result;
  }
  publish(id: string) {
    return this.exclusive(async () => {
      const snapshot = this.repository.snapshot();
      if (snapshot.mode !== 'local') throw new Error('演示任务不会发送');
      const task = snapshot.localTasks.find(item => item.id === id);
      if (!task || task.status !== 'outbox') throw new Error('任务不在真实待发送列表');
      const status = await this.native.status();
      if (!status.configured || status.device !== 'phone') throw new Error('请先在设置中导入手机设备凭据');
      if (task.relayOrigin && task.relayOrigin !== status.url) throw new Error('此任务已尝试发往原服务，请恢复原服务后重试');
      const input = toPublishInput(task);
      // Persist the destination before sending: a lost HTTP response must never allow local retraction or cross-server retry.
      await this.repository.update(current => ({ ...current, localTasks: current.localTasks.map(item => item.id === id
        ? { ...item, relayOrigin: status.url, sendAttempted: true } : item) }));
      const remote = remoteSchema.parse(await this.native.publish({ origin: status.url, input }));
      if (remote.requestId !== input.requestId || remote.mailbox !== input.mailbox) throw new Error('服务器返回的任务身份不匹配');
      await this.apply(id, remote, status.url, '任务已送达中转服务，等待执行设备确认');
    });
  }
  refresh() {
    return this.exclusive(async () => {
      const status = await this.native.status();
      if (!status.configured) return status;
      const identity = await this.native.identity();
      if (identity.device !== 'phone' || !identity.services.includes('tasks')) throw new Error('设备身份或任务服务不匹配');
      if (this.repository.snapshot().mode !== 'local') return status;
      const tasks = this.repository.snapshot().localTasks.filter(t => t.remoteId && t.relayOrigin === status.url && ['queued', 'running'].includes(t.status));
      let failures = 0;
      for (const task of tasks) {
        try {
          const remote = remoteSchema.parse(await this.native.read({ origin: status.url, id: task.remoteId! }));
          if (remote.id !== task.remoteId || remote.requestId !== task.requestId || remote.mailbox !== task.mailbox) throw new Error('远端任务身份不匹配');
          if (remote.updatedAt !== task.remoteUpdatedAt) await this.apply(task.id, remote, status.url);
        } catch {
          failures++;
        }
      }
      if (failures) throw new Error(`${failures} 个任务暂时无法刷新，原记录已保留；其他任务已继续更新，请稍后重试。`);
      return status;
    });
  }
  private apply(id: string, remote: z.infer<typeof remoteSchema>, origin: string, message?: string) {
    return this.repository.update(current => ({ ...current, localTasks: current.localTasks.map(task => {
      if (task.id !== id || task.relayOrigin !== origin) return task;
      const label = message || (remote.status === 'running' ? remote.progress : null) || ({ queued: '等待执行设备确认', running: '执行设备已领取任务', succeeded: '结果已返回', failed: '任务未完成，已返回说明' }[remote.status]);
      const changed = remote.status !== task.status || remote.result !== (task.result?.[0] ?? null);
      return { ...task, remoteId: remote.id, remoteUpdatedAt: remote.updatedAt, status: remote.status,
        category: '远端任务', result: remote.result ? [remote.result] : undefined,
        unread: task.unread || (changed && ['succeeded', 'failed'].includes(remote.status)),
        activity: changed || task.activity.at(-1)?.label !== label
          ? [...task.activity.slice(-98), { label, time: new Date(remote.updatedAt).toLocaleString('zh-CN') }] : task.activity };
    }) }));
  }
}
