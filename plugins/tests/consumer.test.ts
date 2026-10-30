import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { Consumer } from '../devices/consumer.js';
import type { NativeSessions } from '../devices/native.js';
import { Runtime } from '../shared/runtime.js';
import { Store } from '../shared/store.js';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const action of cleanup.splice(0).reverse()) await action();
});
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'dogo-access-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const store = new Store(directory);
  const runtime = new Runtime(store, {
    readRecord: async () => undefined,
    modifyRecord: async () => undefined,
    deleteRecord: async () => undefined,
  });
  const consumer = new Consumer(runtime.api, store, {} as NativeSessions);
  runtime.consumer = consumer;
  await consumer.start();
  cleanup.push(async () => consumer.stop());
  return { directory, store, runtime, consumer };
}

describe('local device access settings', () => {
  it('offers a usable initial directory without enabling access automatically', async () => {
    const { consumer, store } = await setup();
    expect(consumer.view()).toMatchObject({ enabled: false, cwd: homedir(), online: false });
    expect(await store.read('consumer', null)).toBeNull();
    await consumer.configure(true, consumer.view().cwd);
    expect(await store.read('consumer', null)).toEqual({
      enabled: true,
      cwd: await realpath(homedir()),
    });
  });
  it('reports invalid directories and preserves the previous configuration', async () => {
    const { directory, consumer, store } = await setup();
    const file = join(directory, 'file');
    await writeFile(file, 'not a directory');
    for (const cwd of ['', 'relative/path', file, join(directory, 'missing')]) {
      await expect(consumer.configure(true, cwd)).rejects.toThrow('目录');
      expect(consumer.view().enabled).toBe(false);
      expect(await store.read('consumer', null)).toBeNull();
    }
  });
  it('can switch access off even after its working directory is removed', async () => {
    const { directory, consumer, runtime, store } = await setup();
    const cwd = join(directory, 'workspace');
    await mkdir(cwd);
    await consumer.configure(true, cwd);
    await rm(cwd, { recursive: true });
    await expect(runtime.control('configure', { enabled: false, cwd })).resolves.toMatchObject({
      enabled: false,
      online: false,
    });
    expect(await store.read('consumer', null)).toEqual({ enabled: false, cwd });
  });
  it('allows disabling through the control route with an empty directory', async () => {
    const { runtime, consumer } = await setup();
    await consumer.configure(true, consumer.view().cwd);
    await expect(runtime.control('configure', { enabled: false, cwd: '' })).resolves.toMatchObject({
      enabled: false,
    });
    await expect(runtime.control('configure', { enabled: true, cwd: '' })).rejects.toThrow(
      '请先填写',
    );
    expect(consumer.view().enabled).toBe(false);
  });
  it('does not report access enabled if saving the configuration fails', async () => {
    const { store, consumer } = await setup();
    vi.spyOn(store, 'write').mockRejectedValueOnce(Error('disk full'));
    await expect(consumer.configure(true, consumer.view().cwd)).rejects.toThrow('disk full');
    expect(consumer.view().enabled).toBe(false);
  });
});
