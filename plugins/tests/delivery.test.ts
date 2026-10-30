import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../shared/store.js';
import { Delivery } from '../devices/delivery.js';

const directories: string[] = [];
afterEach(async () => {
  for (const d of directories.splice(0)) await rm(d, { recursive: true, force: true });
});
const frame = {
  id: 'delivery-a',
  lease_token: 'lease-a',
  content_snapshot: '午饭35',
  project: '账本',
  instruction: '记录',
  target_device_id: 'desktop-b',
};
async function setup() {
  const path = await mkdtemp(join(tmpdir(), 'dogo-delivery-'));
  directories.push(path);
  return new Store(path);
}
describe('durable native delivery', () => {
  it('replays an ACK after process reconstruction without resubmitting the prompt', async () => {
    const store = await setup(),
      native = { create: vi.fn(async () => ({})), prompt: vi.fn(async () => ({ accepted: true })) };
    const first = await new Delivery(store, native).receive(frame, 'account', 'desktop-b', '/test');
    const second = await new Delivery(new Store(store.directory), native).receive(
      { ...frame, lease_token: 'new-lease' },
      'account',
      'desktop-b',
      '/different',
    );
    expect(second.native_session_id).toBe(first.native_session_id);
    expect(second.lease_token).toBe('new-lease');
    expect(native.prompt).toHaveBeenCalledTimes(1);
  });
  it('survives a crash after native acceptance before local commit using identical IDs and cwd', async () => {
    const store = await setup();
    let crashed = false;
    const native = {
      create: vi.fn(async () => ({})),
      prompt: vi.fn(async () => {
        if (!crashed) {
          crashed = true;
          throw Error('response lost');
        }
        return { accepted: true };
      }),
    };
    await expect(
      new Delivery(store, native).receive(frame, 'account', 'desktop-b', '/first'),
    ).rejects.toThrow('response lost');
    await new Delivery(new Store(store.directory), native).receive(
      frame,
      'account',
      'desktop-b',
      '/second',
    );
    expect(native.create.mock.calls[1]).toEqual(native.create.mock.calls[0]);
    expect(native.prompt.mock.calls[1]).toEqual(native.prompt.mock.calls[0]);
  });
  it('isolates account identities and refuses changed snapshots or the wrong target', async () => {
    const store = await setup(),
      native = { create: vi.fn(async () => ({})), prompt: vi.fn(async () => ({ accepted: true })) };
    const receiver = new Delivery(store, native),
      a = await receiver.receive(frame, 'account-a', 'desktop-b', '/test');
    const b = await receiver.receive(frame, 'account-b', 'desktop-b', '/test');
    expect(a.native_session_id).not.toBe(b.native_session_id);
    await expect(
      receiver.receive({ ...frame, instruction: 'changed' }, 'account-a', 'desktop-b', '/test'),
    ).rejects.toThrow('内容发生变化');
    await expect(receiver.receive(frame, 'account-a', 'wrong', '/test')).rejects.toThrow(
      '目标设备',
    );
  });
  it('fails closed on corrupt persistence and refuses a second runtime owner', async () => {
    const store = await setup();
    await store.write('test', { x: 1 });
    expect((await stat(join(store.directory, 'test.json'))).mode & 0o777).toBe(0o600);
    await writeFile(join(store.directory, 'broken.json'), '{');
    await expect(store.read('broken', {})).rejects.toThrow();
    const release = await store.lock();
    await expect(store.lock()).rejects.toThrow('另一个 DSH');
    await release();
    await (
      await store.lock()
    )();
  });
});
