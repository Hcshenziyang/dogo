// A deterministic local model for testing the real Harness approval path.
// It must never be mounted in a personal or production DSH profile.
import { LlmAdapter } from 'file:///Applications/DeepSeek%20Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-llm/lib/index.js';
import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, sep } from 'node:path';

export const name = 'approval-fixture';
export const inject = ['llm'];
class Fixture extends LlmAdapter {
  async listModels(provider) { return [{ provider, id: 'fixture', name: 'Fixture', contextWindow: 128000 }]; }
  async resolveModel(provider, id) { return { provider, id, name: 'Fixture', contextWindow: 128000 }; }
  async *stream(options) {
    if (options.messages.some((message) => message.source?.kind === 'tool' || message.role === 'tool')) {
      yield { type: 'text-delta', index: 0, text: 'SYNTHETIC_DONE' };
      yield { type: 'finish', reason: { kind: 'stop' } };
      return;
    }
    yield {
      type: 'tool-call-delta', index: 0, id: 'synthetic-call-1', name: 'bash',
      argumentsDelta: JSON.stringify({ command: 'printf synthetic-approval', description: '合成命令',
        sandbox_permissions: 'danger-full-access', justification: '验证合成审批' }),
    };
    yield { type: 'finish', reason: { kind: 'tool-calls' } };
  }
}
export async function apply(ctx) {
  const home = process.env.DSH_HOME;
  if (!home || !isAbsolute(home)) throw Error('A temporary DSH_HOME is required.');
  const roots = await Promise.all(['/tmp', tmpdir()].map((root) => realpath(root)));
  const realHome = await realpath(home);
  if (!roots.some((root) => realHome.startsWith(root + sep))) throw Error('Temporary DSH_HOME only.');
  ctx.llm.registerAdapter(['dogo-eval'], new Fixture());
}
