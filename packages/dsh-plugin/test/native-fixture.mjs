import { timingSafeEqual, randomUUID } from 'node:crypto';

// Test-only upstream controller entrypoint. Mounted only in a temporary DSH profile.
export const inject = ['webServer', 'sessionController'];
export function apply(ctx) {
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/fixture-native', handler: async (req, res) => {
    const token = Buffer.from(req.headers.authorization ?? ''), expected = Buffer.from('Bearer ' + process.env.DOGO_BRIDGE_TOKEN);
    if (req.headers.origin || token.length !== expected.length || !timingSafeEqual(token, expected)) { res.writeHead(403); res.end(); return; }
    try {
      let raw = ''; for await (const chunk of req) { raw += chunk; if (raw.length > 4096) throw new Error('Fixture input too large'); }
      const input = JSON.parse(raw), sessionId = 'session-' + randomUUID();
      await ctx.sessionController.create({ sessionId, cwd: process.cwd() });
      const { agent } = await ctx.sessionController.resolveAgent(sessionId);
      if (input.localAnswer) {
        let deliveries = 0;
        // First dispatch enters DogO's remote/native race; the nested native dispatch simulates the UI answer.
        agent.ctx.on('user-questions/request', async (_request, next) => ++deliveries === 1 ? next() : ({ answers: [{ id: 'fixture', selected: [], custom: 'LOCAL_ANSWER_731' }] }), { prepend: true });
      }
      await ctx.sessionController.prompt({ sessionId, requestId: randomUUID(), mode: 'queue', content: [{ type: 'text', text: input.prompt }] }, new AbortController().signal);
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ sessionId }));
    } catch { res.writeHead(500); res.end('{}'); }
  } }));
}
