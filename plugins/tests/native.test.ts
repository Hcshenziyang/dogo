import { describe, expect, it, vi } from 'vitest';
vi.mock('@deepseek-ai/dsh-client-connection', () => ({}));
import { NativeSessions } from '../devices/native.js';

function setup() {
  const invoke = vi.fn(async (_call: any): Promise<any> => ({ sessionId: 'session-a' }));
  const open = vi.fn(
    async (_endpoint: string, _payload: unknown, _signal: AbortSignal): Promise<any> =>
      (async function* () {})(),
  );
  return { invoke, open, native: new NativeSessions({ invoke, open } as any) };
}

describe('remote workspace and model operations', () => {
  it('binds creation to the selected remote workspace without overriding its path', async () => {
    const { native, invoke } = setup();
    await native.remote(
      { method: 'create', args: { sessionId: 'session-a', workspaceId: 'project-b' } },
      '/default',
    );
    expect(invoke).toHaveBeenLastCalledWith({
      namespace: 'session',
      method: 'create',
      args: { request: { sessionId: 'session-a', workspaceId: 'project-b' } },
    });
    await native.remote({ method: 'create', args: { sessionId: 'session-b' } }, '/default');
    expect(invoke).toHaveBeenLastCalledWith({
      namespace: 'session',
      method: 'create',
      args: { request: { sessionId: 'session-b', cwd: '/default' } },
    });
    await expect(
      native.remote({ method: 'create', args: { sessionId: 's', cwd: '/arbitrary' } }, '/default'),
    ).rejects.toThrow();
  });

  it('reads the authoritative workspace baseline and closes its temporary stream', async () => {
    const { native, open } = setup();
    const value = {
      items: [
        {
          workspaceId: 'project-b',
          path: '/project',
          title: 'Project B',
          sessionIds: ['session-a'],
        },
      ],
    };
    let closed = false;
    open.mockImplementation(async () =>
      (async function* () {
        try {
          yield { type: 'baseline', value };
          yield { type: 'unneeded-update' };
        } finally {
          closed = true;
        }
      })(),
    );
    expect(await native.remote({ method: 'workspaces', args: {} }, '/default')).toEqual(value);
    expect(open.mock.calls[0].slice(0, 2)).toEqual(['workspace/follow', { args: {} }]);
    expect(open.mock.calls[0][2].aborted).toBe(true);
    expect(closed).toBe(true);
  });

  it('keeps the model catalog request empty and forwards the exact model and reasoning choice', async () => {
    const { native, invoke } = setup();
    await native.remote({ method: 'models', args: {} }, '/default');
    expect(invoke).toHaveBeenLastCalledWith({
      namespace: 'session',
      method: 'modelCatalog',
      args: {},
    });
    const request = {
      sessionId: 'session-a',
      provider: 'provider-b',
      model: 'model-b',
      reasoningEffort: 'high',
    };
    const selected = { provider: 'provider-b', model: 'model-b', reasoningEffort: 'high' };
    invoke.mockResolvedValue({ selected });
    expect(await native.remote({ method: 'selectModel', args: request }, '/default')).toEqual({
      selected,
    });
    expect(invoke).toHaveBeenLastCalledWith({
      namespace: 'session',
      method: 'selectModel',
      args: { request },
    });
  });

  it('preserves native failures and rejects calls outside the fixed interface', async () => {
    const { native, invoke } = setup();
    invoke.mockRejectedValue(Error('session/model-unavailable'));
    await expect(
      native.remote(
        { method: 'selectModel', args: { sessionId: 's', provider: 'p', model: 'missing' } },
        '/default',
      ),
    ).rejects.toThrow('model-unavailable');
    for (const call of [
      { method: 'workspace.delete', args: { workspaceId: 'p' } },
      { method: 'models', args: { secrets: true } },
      { method: 'selectModel', args: { sessionId: 's', provider: '', model: 'm' } },
    ])
      await expect(native.remote(call, '/default')).rejects.toThrow();
  });
});
