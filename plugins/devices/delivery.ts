import { createHash } from 'node:crypto';
import { z } from 'zod';
import { Store } from '../shared/store.js';

const dispatchSchema = z.object({
  id: z.string().min(1).max(128),
  lease_token: z.string().min(1).max(128),
  content_snapshot: z.string().max(256000),
  project: z.string().max(100),
  instruction: z.string().min(1).max(32000),
  target_device_id: z.string(),
});
interface Native {
  create(id: string, cwd: string): Promise<unknown>;
  prompt(session: string, request: string, text: string): Promise<{ accepted: boolean }>;
}
interface Binding {
  sessionId: string;
  cwd: string;
  digest: string;
  accepted: boolean;
}
export class Delivery {
  constructor(
    private store: Store,
    private native: Native,
  ) {}
  async receive(input: unknown, account: string, deviceId: string, cwd: string) {
    const d = dispatchSchema.parse(input);
    if (d.target_device_id !== deviceId) throw Error('投递的目标设备不匹配。');
    const hash = (s: string) => createHash('sha256').update(s).digest('hex');
    const name = 'delivery-' + hash(account + '\0' + d.id);
    const digest = hash(JSON.stringify([d.instruction, d.project, d.content_snapshot]));
    let binding = await this.store.read<Binding | null>(name, null);
    if (binding && binding.digest !== digest)
      throw Error('同一投递 ID 的内容发生变化，已停止处理。');
    if (!binding) {
      binding = {
        sessionId: 'dogo-' + hash(account + '\0' + d.id).slice(0, 48),
        cwd,
        digest,
        accepted: false,
      };
      // Persist intent BEFORE native creation. Both native create and prompt carry stable IDs.
      await this.store.write(name, binding);
    }
    if (!binding.accepted) {
      await this.native.create(binding.sessionId, binding.cwd);
      const text = `${d.instruction}\n\n备忘录项目：${d.project || '未分类'}\n以下是备忘录内容，按上面的用户指令处理：\n${d.content_snapshot}`;
      const result = await this.native.prompt(
        binding.sessionId,
        'dogo-dispatch-' + hash(account + '\0' + d.id).slice(0, 48),
        text,
      );
      if (!result.accepted) throw Error('DSH 尚未确认接收。');
      binding.accepted = true;
      await this.store.write(name, binding);
    }
    return {
      type: 'dispatch.ack',
      dispatch_id: d.id,
      lease_token: d.lease_token,
      native_session_id: binding.sessionId,
    };
  }
}
