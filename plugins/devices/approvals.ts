import type { LocalTypertGateway } from '../vendor/dsh-remote/contract.js';

type Pending = {
  id: string;
  sessionId: string;
  toolName: string;
  callId?: string;
  reason?: string;
  displayReason?: Record<string, string>;
  answering: boolean;
};
type Generation = {
  controller: AbortController;
  clientId?: string;
  ready: boolean;
  pending: Map<string, Pending>;
};
const object = (value: unknown): value is Record<string, any> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

/** One owner event stream shares the Harness approval with its native desktop UI. */
export class Approvals {
  private current?: Generation;
  private retry?: ReturnType<typeof setTimeout>;
  private enabled = false;
  constructor(private readonly gateway: LocalTypertGateway) {}

  start() {
    if (this.enabled) return;
    this.enabled = true;
    this.connect();
  }
  private connect() {
    if (!this.enabled || this.current) return;
    const generation: Generation = { controller: new AbortController(), ready: false, pending: new Map() };
    this.current = generation;
    void this.pump(generation).catch(() => {}).finally(() => {
      if (this.current !== generation) return;
      this.current = undefined;
      if (this.enabled) this.retry = setTimeout(() => this.connect(), 1000);
    });
  }
  private async pump(generation: Generation) {
    const source = await this.gateway.open('$events', { args: {} }, generation.controller.signal);
    for await (const frame of source) {
      if (generation !== this.current || !object(frame)) break;
      if (frame.type === 'ready' && typeof frame.clientId === 'string') {
        generation.clientId = frame.clientId;
        generation.ready = true;
      } else if (frame.type === 'cancel' && typeof frame.eventId === 'string') {
        generation.pending.delete(frame.eventId);
      } else if (frame.type === 'waterfall' && typeof frame.eventId === 'string') {
        if (frame.event !== 'approval/request' || !generation.clientId ||
            typeof frame.agentId !== 'string' || !object(frame.request) || generation.pending.size >= 100) {
          await this.send(generation, frame.eventId, { kind: 'next' }).catch(() => {});
          continue;
        }
        const request = frame.request;
        generation.pending.set(frame.eventId, {
          id: frame.eventId,
          sessionId: frame.agentId,
          toolName: typeof request.toolName === 'string' ? request.toolName : '工具',
          ...(typeof request.callId === 'string' ? { callId: request.callId } : {}),
          ...(typeof request.reason === 'string' ? { reason: request.reason } : {}),
          ...(object(request.displayReason) ? { displayReason: request.displayReason } : {}),
          answering: false,
        });
      }
    }
  }
  private async send(generation: Generation, eventId: string, outcome: unknown) {
    if (!generation.clientId) throw Error('审批通道尚未就绪。');
    const result = await this.gateway.dispatch('$events/result', {
      args: { clientId: generation.clientId, eventId, outcome },
    }, AbortSignal.timeout(5000));
    if (!result.ok) throw Error(result.error.message || '审批回复未能送达。');
  }
  snapshot(sessionId: string, records: any[]) {
    const generation = this.current;
    const items = [...(generation?.pending.values() || [])]
      .filter((p) => p.sessionId === sessionId)
      .map((p) => {
        const call = records.find((r) => r?.event?.type === 'tool/call' && r.event.data?.callId === p.callId);
        const raw = call?.event?.data?.arguments;
        const detail = typeof raw === 'string' ? raw : raw === undefined ? '' : JSON.stringify(raw, null, 2);
        const asked = this.unsettledAsked(p, records);
        const sameCall = [...(generation?.pending.values() || [])].filter(
          (other) => other.sessionId === p.sessionId && other.callId === p.callId,
        );
        return {
          id: p.id, toolName: p.toolName,
          reason: p.displayReason?.zh || p.displayReason?.en || p.reason || '',
          callId: p.callId || '',
          arguments: detail.length <= 128000 ? detail : '',
          detailAvailable: !!p.callId && asked.length === 1 && sameCall.length === 1 && !!detail && detail.length <= 128000,
          answering: p.answering,
        };
      });
    return { available: !!generation?.ready, items };
  }
  private unsettledAsked(pending: Pending, records: any[]) {
    const decided = new Set(records.filter((r) => r?.event?.type === 'approval/decided').map((r) => r.event.data?.id));
    return records.filter((r) => r?.event?.type === 'approval/asked' &&
      typeof r.event.data?.id === 'string' && r.event.data.callId === pending.callId &&
      r.event.data.toolName === pending.toolName && r.event.data.reason === pending.reason &&
      !decided.has(r.event.data.id));
  }
  auditId(sessionId: string, eventId: string, records: any[]) {
    const entry = this.current?.pending.get(eventId);
    if (!entry || entry.sessionId !== sessionId) return undefined;
    const matching = this.unsettledAsked(entry, records);
    return matching.length === 1 ? matching[0].event.data.id as string : undefined;
  }
  async respond(sessionId: string, eventId: string, decision: 'allowed-once' | 'rejected') {
    const generation = this.current;
    const entry = generation?.pending.get(eventId);
    if (!generation?.ready || !entry || entry.sessionId !== sessionId || entry.answering)
      throw Error('审批已结束或状态已变化，请刷新会话。');
    entry.answering = true;
    try {
      await this.send(generation, eventId, { kind: 'result', value: decision });
      // Harness sends cancellation to the other event subscribers, not to the one that answered.
      generation.pending.delete(eventId);
    } catch (error) {
      // A failed acknowledgement can still mean the decision was accepted. Do not resend it.
      throw error;
    }
  }
  async stop() {
    this.enabled = false;
    clearTimeout(this.retry);
    const generation = this.current;
    this.current = undefined;
    if (!generation) return;
    // Let any other Harness approval handler continue when remote access is switched off.
    await Promise.allSettled([...generation.pending.keys()].map((id) => this.send(generation, id, { kind: 'next' })));
    generation.controller.abort();
  }
}
