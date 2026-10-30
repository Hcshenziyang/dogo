// Adapted from ds-harness-remote's typert-gateway-switch tests (MIT; vendor notice).
import { describe, it, expect, vi } from 'vitest';
import { localCarrier } from '../vendor/dsh-remote/carrier.js';

describe('upstream local carrier compatibility', () => {
  it('keeps the admitted peer on invoke and dispatch without changing the gateway', async () => {
    const invoke = vi.fn(async () => 42),
      dispatchRpc = vi.fn(async () => ({ ok: true as const, value: 42 }));
    const gateway = { invoke, dispatchRpc },
      peer = { signal: new AbortController().signal },
      signal = new AbortController().signal;
    const local = localCarrier(gateway, peer);
    await local.invoke({ namespace: 'session', method: 'list', args: {} });
    expect(invoke).toHaveBeenCalledWith({ namespace: 'session', method: 'list', args: {}, peer });
    await local.dispatch('session/list', { args: {} }, signal);
    expect(dispatchRpc).toHaveBeenCalledWith('session/list', { args: {} }, signal, peer);
    expect(gateway.invoke).toBe(invoke);
  });
  it('puts cancellation in slot five and links RC.1 stream lifetime', async () => {
    const signal = new AbortController(),
      peer = {},
      values = (async function* () {
        yield 1;
      })();
    const open = vi.fn(async function (
      _endpoint: string,
      _payload: unknown,
      _uplink: any,
      _peer: unknown,
      _signal: AbortSignal,
      _control: AbortController,
    ) {
      return values;
    });
    const local = localCarrier({ invoke: vi.fn(), openWireStream: open } as any, peer);
    await local.open('session/follow', { args: {} }, signal.signal);
    const args = open.mock.calls[0];
    expect(args[3]).toBe(peer);
    expect(args[4]).toBe(signal.signal);
    expect(await args[2][Symbol.asyncIterator]().next()).toMatchObject({ done: true });
    signal.abort();
    expect(args[5].signal.aborted).toBe(true);
  });
  it('preserves the legacy three argument stream signature', async () => {
    const open = vi.fn(async function (_endpoint: string, _payload: unknown, _signal: AbortSignal) {
      return (async function* () {
        yield 'legacy';
      })();
    });
    const signal = new AbortController().signal;
    const stream = await localCarrier(
      { invoke: vi.fn(), wireStream: { open, failure: vi.fn() } } as any,
      {},
    ).open('session/follow', { args: {} }, signal);
    expect(open).toHaveBeenCalledWith('session/follow', { args: {} }, signal);
    expect((await stream[Symbol.asyncIterator]().next()).value).toBe('legacy');
  });
  it('rejects malformed carrier args and preserves native error codes', async () => {
    const local = localCarrier(
      {
        invoke: async () => {
          throw Object.assign(Error('missing'), {
            code: 'session/not-found',
            details: { id: 'a' },
          });
        },
      },
      {},
    );
    expect(
      await local.dispatch('session/list', { args: {} }, new AbortController().signal),
    ).toMatchObject({ ok: false, error: { code: 'session/not-found' } });
    expect(await local.dispatch('session/list', [], new AbortController().signal)).toMatchObject({
      ok: false,
    });
  });
});
