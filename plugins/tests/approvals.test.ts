import { describe, expect, it, vi } from 'vitest';
vi.mock('@deepseek-ai/dsh-client-connection', () => ({}));
import { NativeSessions } from '../devices/native.js';

class Frames implements AsyncIterable<unknown> {
  private values: unknown[] = [];
  private wake?: () => void;
  private closed = false;
  push(value: unknown) { this.values.push(value); this.wake?.(); }
  close() { this.closed = true; this.wake?.(); }
  async *[Symbol.asyncIterator]() {
    while (!this.closed || this.values.length) {
      if (this.values.length) yield this.values.shift();
      else await new Promise<void>((resolve) => { this.wake = resolve; });
    }
  }
}
function fixture(actualOutcome: 'allowed-once' | 'rejected' = 'allowed-once') {
  const frames = new Frames();
  const records: any[] = [
    { event: { type: 'tool/call', data: { callId: 'call-1', name: 'bash', arguments: '{"command":"echo synthetic"}' } } },
    { event: { type: 'approval/asked', data: { id: 'audit-1', callId: 'call-1', toolName: 'bash', reason: 'test reason' } } },
  ];
  const dispatch = vi.fn(async (_endpoint: string, payload: any) => {
    const { eventId, outcome } = payload.args;
    if (outcome.kind === 'result') {
      records.push({ event: { type: 'approval/decided', data: { id: 'audit-1', outcome: actualOutcome } } });
    }
    return { ok: true } as const;
  });
  const open = vi.fn(async (endpoint: string) => {
    if (endpoint === '$events') return frames;
    return (async function* () { yield { type: 'snapshot', records: JSON.parse(JSON.stringify(records)) }; })();
  });
  const native = new NativeSessions({ dispatch, open } as any);
  native.startApprovals();
  frames.push({ type: 'ready', clientId: 'client-1' });
  const approval = (id = 'event-1', sessionId = 'session-1') => frames.push({
    type: 'waterfall', event: 'approval/request', eventId: id, agentId: sessionId,
    request: { toolName: 'bash', callId: 'call-1', reason: 'test reason', displayReason: { zh: '需要授权' } },
  });
  return { native, frames, records, dispatch, approval };
}

describe('native approval bridge', () => {
  it('shows the exact pending call and confirms the recorded outcome', async () => {
    const { native, frames, dispatch, approval } = fixture();
    approval();
    await vi.waitFor(async () => expect((await native.snapshot('session-1')).dogoApprovals.items).toHaveLength(1));
    const shown = (await native.snapshot('session-1')).dogoApprovals;
    expect(shown.available).toBe(true);
    expect(shown.items[0]).toMatchObject({ id: 'event-1', reason: '需要授权', detailAvailable: true });
    expect(shown.items[0].arguments).toContain('echo synthetic');
    expect((await native.snapshot('other')).dogoApprovals.items).toHaveLength(0);
    await expect(native.respondApproval('other', 'event-1', 'allowed-once')).rejects.toThrow();
    expect(await native.respondApproval('session-1', 'event-1', 'allowed-once')).toEqual({ status: 'resolved', outcome: 'allowed-once' });
    expect(dispatch).toHaveBeenCalledWith('$events/result', {
      args: { clientId: 'client-1', eventId: 'event-1', outcome: { kind: 'result', value: 'allowed-once' } },
    }, expect.any(AbortSignal));
    expect((await native.snapshot('session-1')).dogoApprovals.items).toHaveLength(0);
    await expect(native.respondApproval('session-1', 'event-1', 'allowed-once')).rejects.toThrow();
    await native.stopApprovals(); frames.close();
  });
  it('reports the audited result when a competing decision wins', async () => {
    const { native, frames, approval } = fixture('rejected');
    approval();
    await vi.waitFor(async () => expect((await native.snapshot('session-1')).dogoApprovals.items).toHaveLength(1));
    expect(await native.respondApproval('session-1', 'event-1', 'allowed-once')).toEqual({ status: 'resolved', outcome: 'rejected' });
    await native.stopApprovals(); frames.close();
  });
  it('does not retry when the acknowledgement is lost', async () => {
    const { native, frames, dispatch, approval } = fixture();
    approval();
    await vi.waitFor(async () => expect((await native.snapshot('session-1')).dogoApprovals.items).toHaveLength(1));
    dispatch.mockRejectedValueOnce(Error('acknowledgement lost'));
    await expect(native.respondApproval('session-1', 'event-1', 'allowed-once')).rejects.toThrow('acknowledgement lost');
    expect((await native.snapshot('session-1')).dogoApprovals.items[0].answering).toBe(true);
    await expect(native.respondApproval('session-1', 'event-1', 'allowed-once')).rejects.toThrow();
    await native.stopApprovals(); frames.close();
  });
  it('refuses a decision when the exact tool arguments or audit cannot be confirmed', async () => {
    const { native, frames, records, dispatch, approval } = fixture();
    records.shift();
    approval();
    await vi.waitFor(async () => expect((await native.snapshot('session-1')).dogoApprovals.items).toHaveLength(1));
    expect((await native.snapshot('session-1')).dogoApprovals.items[0].detailAvailable).toBe(false);
    await expect(native.respondApproval('session-1', 'event-1', 'allowed-once')).rejects.toThrow('详情不可用');
    expect(dispatch).not.toHaveBeenCalled();
    await native.stopApprovals(); frames.close();
  });
  it('passes other event types on, and releases pending approvals on stop', async () => {
    const { native, frames, dispatch, approval } = fixture();
    frames.push({ type: 'waterfall', event: 'other/request', eventId: 'other-1', agentId: 'session-1', request: {} });
    approval();
    await vi.waitFor(async () => expect((await native.snapshot('session-1')).dogoApprovals.items).toHaveLength(1));
    await native.stopApprovals(); frames.close();
    expect(dispatch.mock.calls.map((args) => (args[1] as any).args)).toEqual(expect.arrayContaining([
      expect.objectContaining({ eventId: 'other-1', outcome: { kind: 'next' } }),
      expect.objectContaining({ eventId: 'event-1', outcome: { kind: 'next' } }),
    ]));
    expect((await native.snapshot('session-1')).dogoApprovals.available).toBe(false);
  });
});
