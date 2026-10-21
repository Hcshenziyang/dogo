import { z } from 'zod';

export class ServiceError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
export const mailbox = z.string().regex(/^\/tasks\/[a-z0-9][a-z0-9_-]{0,63}$/);
export const configSchema = z.object({
  host: z.enum(['127.0.0.1', '::1']).default('127.0.0.1'),
  port: z.number().int().min(0).max(65535).default(8787),
  allowedHosts: z.array(z.string().min(1)).min(1).default(['127.0.0.1', 'localhost', '[::1]']),
  publicOrigin: z.string().url().refine(value => {
    const u = new URL(value);
    return !u.username && !u.password && !u.search && !u.hash && u.pathname === '/' &&
      (u.protocol === 'https:' || (u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)));
  }).optional(),
  webRoot: z.string().startsWith('/').optional(),
  database: z.string().min(1),
  services: z.array(z.enum(['tasks', 'memory'])).min(1).default(['tasks', 'memory']),
  devices: z.array(z.object({
    id,
    tokenEnv: z.string().regex(/^[A-Z][A-Z0-9_]+$/),
    publishTo: z.array(mailbox).default([]),
    memory: z.boolean().default(false),
  }).strict()).default([]),
  mailboxes: z.record(mailbox, id).default({}),
}).strict().superRefine((config, ctx) => {
  const devices = new Set(config.devices.map(d => d.id));
  if (devices.size !== config.devices.length) ctx.addIssue({ code: 'custom', message: 'Duplicate device ID' });
  for (const device of Object.values(config.mailboxes)) {
    if (!devices.has(device)) ctx.addIssue({ code: 'custom', message: `Unknown mailbox device: ${device}` });
  }
  for (const device of config.devices) for (const path of device.publishTo) {
    if (!config.mailboxes[path]) ctx.addIssue({ code: 'custom', message: `Unknown publish path: ${path}` });
  }
});

export type Config = z.infer<typeof configSchema>;
export type Device = Config['devices'][number];
export const createTaskSchema = z.object({
  requestId: id,
  mailbox,
  title: z.string().min(1).max(300),
  instructions: z.string().min(1).max(64_000),
}).strict();
export type CreateTask = z.infer<typeof createTaskSchema>;
export const claimSchema = z.object({ executionId: id }).strict();
export const progressSchema = z.object({ executionId: id, message: z.string().min(1).max(4000) }).strict();
export const finishSchema = z.object({
  executionId: id,
  status: z.enum(['succeeded', 'failed']),
  result: z.string().min(1).max(128_000),
}).strict();
export type FinishTask = z.infer<typeof finishSchema>;
export type Task = CreateTask & {
  id: string;
  sender: string;
  executor: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  executionId: string | null;
  progress: string | null;
  result: string | null;
  createdAt: number;
  updatedAt: number;
};

export { memoryPath, memoryWriteSchema } from '@dogo/sync-client/schema';
export type { MemoryFile } from '@dogo/sync-client/schema';
