import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoService } from '../memos/service.js';
import { Runtime } from '../shared/runtime.js';
import { Store } from '../shared/store.js';

const paths: string[] = [];
afterEach(async () => {
  for (const path of paths.splice(0)) await rm(path, { recursive: true, force: true });
});

it('serves the same local notes to the UI and AI without any login or network request', async () => {
  const path = await mkdtemp(join(tmpdir(), 'dogo-memo-service-'));
  paths.push(path);
  const runtime = new Runtime(new Store(path), {
    readRecord: async () => undefined,
    modifyRecord: async () => undefined,
    deleteRecord: async () => undefined,
  });
  const network = vi.spyOn(runtime.api, 'request');
  const service = new MemoService(runtime);
  const stop = service.sync.start();
  try {
    expect(await service.control('status')).toMatchObject({
      loggedIn: false,
      memoIdentity: 'unowned',
    });
    const created = await service.submit({
      method: 'create',
      data: { request_id: 'local-service', content: '本机内容' },
    });
    const listed = await service.control('list', {});
    expect(listed.items).toEqual([created]);
    await service.control('submit', {
      method: 'append',
      id: created.id,
      data: { revision: created.revision, content: ' + AI' },
    });
    expect((await service.control('get', { id: created.id })).content).toBe('本机内容 + AI');
    expect(network).not.toHaveBeenCalled();
  } finally {
    stop();
    await service.sync.wait();
  }
});

it('uses live device status when connected and marks cached status unknown on failure or timeout', async () => {
  const path = await mkdtemp(join(tmpdir(), 'dogo-memo-devices-'));
  paths.push(path);
  const runtime = new Runtime(new Store(path), {
    readRecord: async () => undefined,
    modifyRecord: async () => undefined,
    deleteRecord: async () => undefined,
  });
  const service = new MemoService(runtime);
  vi.spyOn(service.sync, 'owner').mockReturnValue('account');
  vi.spyOn(service.sync, 'ensureReachableBeforeRefresh').mockResolvedValue();
  const device = { id: 'desktop', name: '电脑', kind: 'desktop', active: true, online: true };
  await runtime.store.write('memo-devices-account', [device]);
  const fetchDevices = vi.spyOn(runtime, 'control').mockResolvedValueOnce([device]);

  expect(await service.control('devices')).toEqual([device]);
  fetchDevices.mockRejectedValueOnce(Error('network unavailable'));
  expect(await service.control('devices')).toEqual([{ ...device, online: undefined }]);
  fetchDevices.mockImplementationOnce(() => new Promise(() => {}));
  expect(await service.control('devices')).toEqual([{ ...device, online: undefined }]);
});
