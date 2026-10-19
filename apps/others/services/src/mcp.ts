import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { claimSchema, createTaskSchema, finishSchema, id, progressSchema, ServiceError } from './schema.ts';
import type { Device } from './schema.ts';
import type { Store } from './store.ts';
import { Hub, hubSchemas } from './hub.ts';
import { MemoryService, memoryOps } from './memory.ts';

export function createMcp(store: Store, device: Device, hub = new Hub(store)) {
  const server = new McpServer({ name: 'dogo-tasks', version: '0.0.0' });
  const tool = <T extends z.ZodRawShape>(name: string, description: string, shape: T, fn: (args: z.infer<z.ZodObject<T>>) => unknown) => {
    server.registerTool(name, { description, inputSchema: shape as z.ZodRawShape }, async (args) => {
      try {
        const result = fn(z.object(shape).strict().parse(args));
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
      } catch (error) {
        const message = error instanceof ServiceError ? error.message : 'Internal service error';
        return { isError: true, content: [{ type: 'text' as const, text: message }] };
      }
    });
  };
  tool('task_create', 'Write a task to an allowed mailbox. Reuse requestId on retries. This does not execute it.', createTaskSchema.shape,
    args => store.create(device, args));
  tool('task_list', 'List sent and assigned tasks, paginated by nextCursor.', { after: z.number().int().nonnegative().default(0) },
    args => store.tasks(device, args.after));
  tool('task_get', 'Read a task and its progress/result. Only sender or assigned executor can read it.', { taskId: id },
    args => store.task(device, args.taskId));
  tool('task_claim', 'Assigned executor only. Persist executionId locally before claiming; never execute again just because claim is retried.',
    { taskId: id, ...claimSchema.shape }, args => store.claim(device, args.taskId, args.executionId));
  tool('task_progress', 'Assigned executor reports progress for its existing execution.', { taskId: id, ...progressSchema.shape },
    args => store.progress(device, args.taskId, args.executionId, args.message));
  tool('task_finish', 'Store an execution result and notify the original sender. Do not claim tests ran without evidence.',
    { taskId: id, ...finishSchema.shape }, args => store.finish(device, args.taskId, args));
  for (const op of ['snapshot', 'history', 'details', 'create', 'send', 'stop', 'note', 'noteState', 'answer', 'artifactBegin', 'artifactChunk', 'artifactSeal', 'artifactRead'] as const) {
    tool(`dogo_${op}`, `DogO v2 ${op}. create/send execute on the original authorized device; note only stores material, never executes. Reuse requestId on retries.`,
      hubSchemas[op].shape, args => hub.execute(device, op, args));
  }
  const memory = new MemoryService(store);
  for (const op of ['list', 'read', 'write', 'conflicts'] as const) {
    tool(`personal_memory_${op}`, `Personal shared memory ${op}. Dedicated folder only; write uses baseVersion and preserves conflicting versions. Requires memory authorization.`,
      memoryOps[op].shape, args => memory.execute(device, op, args));
  }
  return server;
}
