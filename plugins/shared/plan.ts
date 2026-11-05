import { z } from 'zod';

export const planSchema = z
  .object({
    instruction: z.string().min(1).max(32000),
    target_device_id: z.string().min(1).max(128),
    mode: z.enum(['once', 'daily', 'weekly', 'monthly']),
    enabled: z.boolean().default(true),
    timezone: z.string().min(1).max(100).default('Asia/Shanghai'),
    run_at: z.number().int().positive().nullable().default(null),
    time: z
      .string()
      .regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/)
      .default('09:00'),
    weekday: z.number().int().min(0).max(6).nullable().default(null),
    day: z.number().int().min(1).max(31).nullable().default(null),
  })
  .strict();
