import { capabilityPolicy } from '@dogo/contracts/host';
export class NativeCapabilities {
  constructor() { this.policy = { computer: false, codex: false, sshHosts: [] }; this.active = new Map(); this.available = false; }
  async refresh() {
    if (!process.env.DOGO_CAPABILITY_URL || !process.env.DOGO_CAPABILITY_TOKEN) return this.snapshot();
    const response = await fetch(process.env.DOGO_CAPABILITY_URL, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(3000),
      headers: { authorization: 'Bearer ' + process.env.DOGO_CAPABILITY_TOKEN, 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'status', args: {} }) });
    if (!response.ok) throw new Error('设备能力连接不可用');
    const state = await response.json(); this.policy = capabilityPolicy.parse(state.policy); this.available = true; this.nativeActive = state.active ?? 0;
    return this.snapshot();
  }
  snapshot() { return { policy: this.policy, active: this.nativeActive ?? 0, available: this.available }; }
  async configure() { throw new Error('请通过客户端原生设置修改设备权限'); }
  async close() { this.available = false; }
}
