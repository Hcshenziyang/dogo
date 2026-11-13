// Deterministic model for a temporary DSH only; it does not contact a provider.
import { LlmAdapter } from 'file:///Applications/DeepSeek%20Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-llm/lib/index.js';
import { appendFile, realpath } from 'node:fs/promises';
import { isAbsolute, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout } from 'node:timers/promises';

export const name = 'workspace-page-eval';
export const inject = ['llm'];

class Fixture extends LlmAdapter {
  async listModels(provider) {
    return [{ provider, id: 'fixture', name: 'Fixture', contextWindow: 128000 }];
  }
  async resolveModel(provider, model) {
    return { provider, id: model, name: 'Fixture', contextWindow: 128000 };
  }
  async *stream(options) {
    const context = options.messages.filter((m) => m.source?.kind === 'dogo-workspace').at(-1);
    const user = options.messages.filter((m) => m.source?.kind === 'user').at(-1);
    await appendFile(
      process.env.EVAL_MODEL_LOG,
      JSON.stringify({ user: user?.content, context: context?.content }) + '\n',
    );
    if (JSON.stringify(user?.content).includes('慢速测试'))
      await setTimeout(1200, undefined, { signal: options.signal });
    yield { type: 'text-delta', index: 0, text: 'EVAL_OK' };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}

export async function apply(ctx) {
  const { DSH_HOME: home, EVAL_MODEL_LOG: log } = process.env;
  if (!home || !isAbsolute(home) || !log || !isAbsolute(log))
    throw Error('A temporary DSH_HOME and EVAL_MODEL_LOG are required.');
  const realHome = await realpath(home);
  const roots = await Promise.all(['/tmp', tmpdir()].map((root) => realpath(root)));
  if (!roots.some((root) => realHome.startsWith(root + sep)))
    throw Error('The model fixture only runs with a temporary DSH_HOME.');
  ctx.llm.registerAdapter(['dogo-eval'], new Fixture());
}
