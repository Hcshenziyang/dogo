// Derived from ds-harness-remote v0.5.18 (MIT); see ORIGIN.md.
import type { LegacyWireStreamOpen, LocalTypertGateway, Rc1WireStreamOpen, TypertGatewayLike, TypertGatewayRequest, TypertRpcResult } from './contract.js';
type CarrierDispatch = (endpoint: string, payload: unknown, signal: AbortSignal, peer?: unknown) => Promise<TypertRpcResult>;
type CarrierOpen = (endpoint: string, payload: unknown, signal: AbortSignal, uplink?: AsyncIterable<unknown>, peer?: unknown) => Promise<AsyncIterable<unknown>>;
type Rc1OpenWireStream = (endpoint: string, payload: unknown, uplink: AsyncIterable<unknown>, peer: unknown, signal: AbortSignal, control: AbortController) => Promise<AsyncIterable<unknown>>;
interface RuntimeGateway extends TypertGatewayLike { dispatchRpc?: CarrierDispatch; openWireStream?: CarrierOpen | Rc1OpenWireStream; }
export function localCarrier(gateway: TypertGatewayLike, peer: unknown): LocalTypertGateway {
  const runtime = gateway as RuntimeGateway;
  const originalInvoke = gateway.invoke.bind(gateway);
  const localDispatch = runtime.dispatchRpc?.bind(gateway);
  const localStream = gateway.stream?.bind(gateway);
  const localOpen = createLocalOpen(gateway, runtime);
  const invoke = (request: TypertGatewayRequest) => originalInvoke({ ...request, peer });
  const failure = (error: unknown) => {
    const e = error as {code?: string; message?: string; details?: Record<string, unknown>};
    return {code: e?.code ?? 'gateway/internal', message: e?.message ?? 'DSH call failed', details: e?.details ?? {}};
  };
  return {
    peer, invoke, failure, supportsCarrier: localOpen !== undefined,
    dispatch: localDispatch ? (endpoint, payload, signal) => localDispatch(endpoint, payload, signal, peer) : async (endpoint, payload, signal) => {
      try { return {ok: true, value: await invoke(requestFromCarrier(endpoint, payload, signal))}; }
      catch (error) { return {ok: false, error: failure(error)}; }
    },
    open: localOpen ? (endpoint, payload, signal, uplink) => localOpen(endpoint, payload, signal, uplink, peer) : async (endpoint, payload, signal) => {
      if (!localStream) throw new Error('The local Harness Gateway does not support Remote streams.');
      return localStream({...requestFromCarrier(endpoint, payload, signal), peer});
    },
  };
}

/**
 * dsh 0.1.7-rc.1 moved the cancellation signal from the third parameter to the
 * fifth; legacy releases keep `(endpoint, payload, signal)`.
 * @param open - carrier opener captured from the running release.
 * @returns whether the opener follows the rc.1 argument order.
 */
function usesRc1Arity(open: { readonly length: number }): boolean {
  return open.length >= 5
}

/** An uplink nobody sends on, so a read-only stream opens without buffering. */
function endedUplink(): AsyncIterable<unknown> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<unknown> {
      return { next: () => Promise.resolve({ done: true, value: undefined }) }
    },
  }
}

/** Controller aborted with the logical stream so the rc.1 carrier owns one lifetime. */
function linkControl(signal: AbortSignal): AbortController {
  const control = new AbortController()
  if (signal.aborted) control.abort(signal.reason)
  else signal.addEventListener('abort', () => control.abort(signal.reason), { once: true })
  return control
}

/**
 * Adapt the running release's carrier opener to the plugin's 3-argument
 * `(endpoint, payload, signal)` seam without leaking the argument displacement.
 * @param gateway - official Gateway whose public `wireStream` is the fallback.
 * @param runtime - Gateway object owning the private `openWireStream` dispatcher.
 * @returns a local opener that carries the signal to the release's signal slot.
 */
function createLocalOpen(gateway: TypertGatewayLike, runtime: RuntimeGateway): CarrierOpen | undefined {
  const open = runtime.openWireStream
  if (open !== undefined) {
    return usesRc1Arity(open)
      ? (endpoint, payload, signal, uplink, peer) => (open as Rc1OpenWireStream)
        .call(runtime, endpoint, payload, uplink ?? endedUplink(), peer, signal, linkControl(signal))
      : (endpoint, payload, signal) => (open as CarrierOpen).call(runtime, endpoint, payload, signal)
  }
  const wire = gateway.wireStream
  if (wire === undefined) return undefined
  const wireOpen = wire.open
  if (usesRc1Arity(wireOpen)) {
    const rc1 = wireOpen as Rc1WireStreamOpen
    return (endpoint, payload, signal, uplink, peer) => rc1.call(wire, endpoint, payload, uplink ?? endedUplink(), peer, signal)
  }
  const legacy = wireOpen as LegacyWireStreamOpen
  return (endpoint, payload, signal) => legacy.call(wire, endpoint, payload, signal)
}

function requestFromCarrier(endpoint: string, payload: unknown, signal: AbortSignal): TypertGatewayRequest {
  const segments = endpoint.split('/')
  if (segments.length !== 2 || segments.some(segment => segment.length === 0)) {
    throw new Error('The Harness Gateway endpoint is invalid.')
  }
  if (!isRecord(payload) || !isRecord(payload.args)) {
    throw new Error('The Harness Gateway payload is invalid.')
  }
  return { namespace: segments[0]!, method: segments[1]!, args: payload.args, signal }
}


function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
