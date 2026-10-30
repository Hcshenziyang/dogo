// Deterministic model fixture. DSH's session/agent/persistence runtime remains real.
// Never install this plugin in a personal or production profile.
import { LlmAdapter } from 'file:///Applications/DeepSeek%20Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-llm/lib/index.js';
import { appendFile } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';
export const name = 'dogo-evaluation-model';
export const inject = ['llm'];
class Fixture extends LlmAdapter {
  async listModels(provider) {
    return ['fixture', 'fixture-alt'].map((id) => ({
      provider,
      id,
      name: id,
      contextWindow: 128000,
    }));
  }
  async resolveModel(provider, model) {
    return {
      provider,
      id: model,
      name: model,
      contextWindow: 128000,
      reasoning: {
        efforts: [
          { id: 'low', name: '低' },
          { id: 'high', name: '高' },
        ],
        defaultEffort: 'low',
      },
    };
  }
  async *stream(options) {
    const input = options.messages
      .filter((m) => m.role === 'user')
      .flatMap((m) => m.content)
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n');
    const marker = [...input.matchAll(/toolmemo-[0-9a-f-]{36}/g)].at(-1)?.[0];
    if (marker) {
      const blocks = options.messages.flatMap((m) => m.content);
      const calls = blocks.filter((b) => b.type === 'tool-call' && b.id.startsWith(marker));
      const name =
        calls.length === 0 ? 'dogo_write_memo' : calls.length === 1 ? 'dogo_list_memos' : undefined;
      await appendFile(
        process.env.EVAL_CACHE + '/tool-fixture.jsonl',
        JSON.stringify({
          marker,
          names: (options.tools || []).map((t) => t.name),
          next: name || 'done',
        }) + '\n',
      );
      if (name) {
        const args =
          name === 'dogo_write_memo'
            ? {
                data: {
                  method: 'create',
                  data: { request_id: marker, content: marker, project: 'tool-eval' },
                },
              }
            : { project: 'tool-eval' };
        yield {
          type: 'tool-call-delta',
          index: 0,
          id: marker + '-' + calls.length,
          name,
          argumentsDelta: JSON.stringify(args),
        };
        yield { type: 'finish', reason: { kind: 'tool-calls' } };
      } else {
        yield { type: 'text-delta', index: 0, text: 'TOOL_COMPLETE:' + marker };
        yield { type: 'finish', reason: { kind: 'stop' } };
      }
      return;
    }
    // DSH appends permission/context user messages; select our unique task marker.
    const text =
      [...input.matchAll(/(?:disconnect|continue|queue)-[0-9a-f-]{36}/g)].at(-1)?.[0] ??
      'no-evaluation-marker';
    await appendFile(
      process.env.EVAL_CACHE + '/model-attempts.jsonl',
      JSON.stringify({ text, phase: 'start' }) + '\n',
    );
    yield { type: 'text-delta', index: 0, text: 'EVAL_REPLY:' };
    await setTimeout(1800, undefined, { signal: options.signal });
    yield { type: 'text-delta', index: 0, text };
    yield { type: 'finish', reason: { kind: 'stop' } };
    await appendFile(
      process.env.EVAL_CACHE + '/model-attempts.jsonl',
      JSON.stringify({ text, phase: 'finished' }) + '\n',
    );
  }
}
export function apply(ctx) {
  ctx.llm.registerAdapter(['dogo-eval'], new Fixture());
}
