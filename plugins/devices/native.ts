import * as Connection from '@deepseek-ai/dsh-client-connection';
import { z } from 'zod';
import { localCarrier } from '../vendor/dsh-remote/carrier.js';
import type { LocalTypertGateway } from '../vendor/dsh-remote/contract.js';

const id = z.string().min(1).max(128);
export const remoteCall = z.discriminatedUnion('method', [
  z.object({
    method: z.literal('list'),
    args: z.object({ cursor: z.string().optional() }).strict(),
  }),
  z.object({ method: z.literal('snapshot'), args: z.object({ sessionId: id }).strict() }),
  z.object({
    method: z.literal('create'),
    args: z.object({ sessionId: id, workspaceId: id.optional() }).strict(),
  }),
  z.object({ method: z.literal('workspaces'), args: z.object({}).strict() }),
  z.object({ method: z.literal('models'), args: z.object({}).strict() }),
  z.object({
    method: z.literal('selectModel'),
    args: z
      .object({
        sessionId: id,
        provider: z.string().min(1).max(256),
        model: z.string().min(1).max(256),
        reasoningEffort: z.string().min(1).max(128).optional(),
      })
      .strict(),
  }),
  z.object({
    method: z.literal('prompt'),
    args: z.object({ sessionId: id, requestId: id, text: z.string().min(1).max(256000) }).strict(),
  }),
  z.object({ method: z.literal('cancel'), args: z.object({ sessionId: id }).strict() }),
]);
export class NativeSessions {
  constructor(readonly gateway: LocalTypertGateway) {}
  async invoke(method: string, request?: unknown): Promise<any> {
    return this.gateway.invoke({
      namespace: 'session',
      method,
      args: request === undefined ? {} : method === 'list' ? { _request: request } : { request },
    });
  }
  async create(sessionId: string, cwd: string) {
    return this.invoke('create', { sessionId, cwd });
  }
  async prompt(sessionId: string, requestId: string, text: string) {
    return this.invoke('prompt', {
      sessionId,
      requestId,
      mode: 'queue',
      content: [{ type: 'text', text }],
    });
  }
  async snapshot(sessionId: string) {
    return this.firstFrame('session/follow', {
      args: { request: { address: { kind: 'session', sessionId }, maxMessages: 30 } },
    });
  }
  private async firstFrame(endpoint: string, payload: unknown): Promise<any> {
    const control = new AbortController();
    const timer = setTimeout(() => control.abort(), 10000);
    try {
      const stream = await this.gateway.open(endpoint, payload, control.signal);
      const iterator = stream[Symbol.asyncIterator]();
      try {
        const result = await iterator.next();
        if (result.done) throw Error('远端 DSH 未返回数据。');
        return result.value;
      } finally {
        control.abort();
        await iterator.return?.();
      }
    } finally {
      clearTimeout(timer);
      control.abort();
    }
  }
  async remote(input: unknown, cwd: string) {
    const call = remoteCall.parse(input);
    switch (call.method) {
      case 'list':
        return this.invoke('list', call.args);
      case 'snapshot':
        return this.snapshot(call.args.sessionId);
      case 'create':
        return call.args.workspaceId
          ? this.invoke('create', call.args)
          : this.create(call.args.sessionId, cwd);
      case 'workspaces': {
        const frame = await this.firstFrame('workspace/follow', { args: {} });
        if (frame?.type !== 'baseline' || !Array.isArray(frame.value?.items))
          throw Error('远端 DSH 未返回项目列表，请确认已更新设备插件与 DSH。');
        return frame.value;
      }
      case 'models':
        return this.invoke('modelCatalog');
      case 'selectModel':
        return this.invoke('selectModel', call.args);
      case 'prompt':
        return this.prompt(call.args.sessionId, call.args.requestId, call.args.text);
      case 'cancel':
        return this.invoke('cancel', call.args);
    }
  }
}
export function attachNative(ctx: any) {
  const Peer = Connection.Peer ?? Connection.OperatorPeer;
  if (!Peer) throw Error('此 DSH 版本缺少原生 Peer 接口。');
  const peer = new Peer(ctx, { principal: { kind: 'owner' } });
  const sessions = new NativeSessions(localCarrier(ctx.typertGateway, peer));
  return { sessions, dispose: () => peer.dispose() };
}
