import { z } from 'zod';
export const HOST_PROTOCOL = 1;
export const DSH_VERSION = '0.2.0-rc.2';
export const hostRequest = z.object({ method: z.string().min(1).max(80), params: z.unknown().optional() }).strict();
export const hostHandshake = z.object({ protocol: z.literal(HOST_PROTOCOL), dshVersion: z.literal(DSH_VERSION), pid: z.number().int().positive(), generation: z.string(), services: z.literal(true) });
export const capabilityPolicy = z.object({ computer: z.boolean(), codex: z.boolean(), sshHosts: z.array(z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/)).max(30) }).strict();
// Browser plugins may use business APIs, never obtain bootstrap credentials or mutate native grants.
export const CLIENT_METHODS = new Set(['snapshot', 'refreshRelay', 'hubAction', 'hubCache', 'memoryAction', 'memorySync']);
