// Explicit opt-in local-model acceptance. Only a generated fixture is authorized.
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { Engine } from '../apps/runtime/src/engine.mjs';

const folder = await realpath(await mkdtemp(path.join(tmpdir(), 'dogo-dsh-smoke-')));
const workspace = path.join(folder, 'fixture');
await mkdir(workspace);
await writeFile(path.join(workspace, 'hello.ts'), "export const dogoDshProbe = 'DSH_OK_2718';\n");
const started = Date.now();
let firstText;
let logCount = 0;
const engine = new Engine(path.join(folder, 'data'), (snapshot) => {
  const task = snapshot.tasks[0];
  if (!task) return;
  if (task.output && firstText === undefined) firstText = Date.now() - started;
  for (const log of task.logs.slice(logCount)) console.log(log.message);
  logCount = task.logs.length;
});
const timer = setTimeout(() => { for (const id of engine.active.keys()) void engine.cancel(id); }, 180000);
try {
  engine.configure({ endpoint: 'http://127.0.0.1:8000/v1', model: 'qwen3.8-27b-local', contextWindow: 32768, maxTokens: 8192, relayUrl: '' });
  const grant = await engine.authorizeWorkspace(workspace);
  const id = engine.create({ kind: 'analysis', workspaceId: grant.id,
    prompt: '先调用 read_workspace_file 读取 hello.ts，然后只输出文件中 dogoDshProbe 的值。不要执行命令。' });
  await engine.active.get(id)?.done;
  const task = engine.store.get(id);
  console.log(JSON.stringify({ status: task.status, output: task.output, error: task.error,
    firstTextMs: firstText, totalMs: Date.now() - started, plugins: engine.dsh.plugins }));
  assert.equal(task.status, 'succeeded', task.error);
  assert.match(task.output, /DSH_OK_2718/);
  assert(task.logs.some((log) => log.message === '只读文件：hello.ts'));
} finally {
  clearTimeout(timer);
  await engine.close();
  await rm(folder, { recursive: true, force: true });
}
