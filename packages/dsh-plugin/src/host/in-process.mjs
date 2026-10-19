import { randomUUID } from 'node:crypto';
import { runLegacy } from './legacy-run.mjs';

/** DSH services are called in process. This adapter never starts another backend. */
export class InProcessDsh {
  constructor(ctx, bridge) { this.ctx = ctx; this.bridge = bridge; this.state = 'ready'; this.generation = process.env.DOGO_LAUNCH_ID ?? randomUUID(); this.native = true; }
  snapshot() { return { state: this.state, generation: this.generation, version: '0.2.0-rc.2', error: '' }; }
  async ensure() { if (this.state !== 'ready') throw new Error('DSH is stopping'); }
  async request(route, body, signal) {
    signal?.throwIfAborted();
    const url = new URL(route, 'http://127.0.0.1');
    if (url.pathname === '/health') return this.bridge.health();
    if (url.pathname === '/run') {
      if (body) return this.bridge.start(body);
      const value = this.bridge.get(url.searchParams.get('id'));
      if (!value) throw Object.assign(new Error('执行接收状态未知，不会重跑'), { status: 404 });
      return value;
    }
    if (url.pathname === '/cancel') return this.bridge.cancel(body.requestId);
    const value = await this.bridge.sessions.route(url.pathname, body ? 'POST' : 'GET', body, url);
    if (value === undefined || value === null) throw Object.assign(new Error('未找到执行记录，不会重跑'), { status: 404 });
    return value;
  }
  run(input) { return runLegacy.call(this, { ...input, settings: { ...input.settings, model: '' } }); }
  async stop() {
    // Cancellation failure must not silently start a replacement backend.
    for (const agent of this.ctx.agents.list()) if (agent.status !== 'idle') agent.cancel({ kind: 'user' });
  }
  async close() { await this.stop(); }
}
