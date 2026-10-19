import { z } from 'zod';
export const serviceOrigin = z.string().url().refine(value => {
    const u = new URL(value);
    return u.protocol === 'https:' && !u.username && !u.password && !u.search && !u.hash && u.pathname === '/';
  }, '设备凭据必须绑定一个 HTTPS 服务地址');
export const pairingSchema = z.discriminatedUnion('version', [z.object({
  version: z.literal(1), url: serviceOrigin,
  device: z.enum(['mac', 'win']),
  token: z.string().regex(/^[A-Za-z0-9_-]{43,128}$/),
}).strict(), z.object({
  version: z.literal(2), url: serviceOrigin, device: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
  platform: z.enum(['mac', 'win']), token: z.string().regex(/^[A-Za-z0-9_-]{43,128}$/),
}).strict()]);
