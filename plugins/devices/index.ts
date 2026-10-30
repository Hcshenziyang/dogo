import { acquire, registerControl } from '../shared/runtime.js';
import { attachNative } from './native.js';
import { Consumer } from './consumer.js';
export const name = 'dogo-devices';
export const inject = ['credentials', 'connection', 'webServer', 'typertGateway'];
export function apply(owner: any) {
  owner.inject(inject, async (ctx: any) => {
    const shared = await acquire(ctx);
    const native = attachNative(ctx);
    const consumer = new Consumer(shared.runtime.api, shared.runtime.store, native.sessions);
    shared.runtime.consumer = consumer;
    ctx.effect(() => async () => {
      consumer.stop();
      shared.runtime.consumer = undefined;
      await native.dispose();
      await shared.release();
    });
    ctx.effect(() => registerControl(ctx, '/dogo-devices', shared.runtime));
    await consumer.start();
  });
}
