// Explicit real-provider acceptance, never part of unattended unit tests.
import { mkdtemp, writeFile, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { Engine } from '../src/engine.mjs';
import { runProcess } from '../src/process.mjs';
if (!process.argv.includes('--run')) throw new Error('Pass --run to authorize a real Codex call in a synthetic temporary project');
const root = await mkdtemp(path.join(tmpdir(), 'dogo-codex-acceptance-'));
const project = path.join(root, 'project'); await (await import('node:fs/promises')).mkdir(project);
await writeFile(path.join(project, 'sum.mjs'), 'export const sum = (a, b) => a - b;\n');
await writeFile(path.join(project, 'sum.test.mjs'), 'import test from "node:test"; import assert from "node:assert/strict"; import {sum} from "./sum.mjs"; test("sum",()=>assert.equal(sum(2,3),5));\n');
const engine = new Engine(path.join(root, 'dogo'));
try {
  const registered = await engine.hub.register(await realpath(project));
  await engine.capabilities.configure({ computer: false, codex: true, sshHosts: [] });
  const result = await engine.capabilities.execute('codex', { projectId: registered.id, prompt: 'Synthetic DogO acceptance task. Fix sum.mjs so sum(2,3) returns 5. Run node --test sum.test.mjs and report the actual outcome. Only touch files in this temporary project. No network, no other directories, no dependency installation, no git commit. Keep the existing test unchanged.' });
  assert(result.success, JSON.stringify(result));
  const verification = await runProcess(process.execPath, ['--test', 'sum.test.mjs'], { cwd: project }); assert.equal(verification.code, 0, verification.stdout + verification.stderr);
  assert.match(await readFile(path.join(project, 'sum.mjs'), 'utf8'), /a\s*\+\s*b/);
  assert(result.commands.some(c => c.command.includes('--test') && c.exitCode === 0));
  console.log(JSON.stringify({ passed: true, root, resultPath: result.resultPath, threadId: result.threadId, testsRechecked: true }));
} finally { await engine.close(); }
