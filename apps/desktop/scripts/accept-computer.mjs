import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';
import { Engine } from '../../../packages/dsh-plugin/test/harness.mjs';
if (!process.argv.includes('--run')) throw new Error('Pass --run to briefly focus a synthetic window and test real GUI controls');
process.env.DOGO_MAC_HELPER = fileURLToPath(new URL('../build/dogo-computer', import.meta.url));
const root = await mkdtemp(path.join(tmpdir(), 'dogo-computer-acceptance-'));
const engine = new Engine(root); await engine.capabilities.configure({ computer: true, codex: false, sshHosts: [] });
const child = spawn(createRequire(import.meta.url)('electron'), [fileURLToPath(new URL('../test/fixtures/computer-app.cjs', import.meta.url))], { stdio: ['ignore', 'pipe', 'pipe'] });
let bounds, received, error = ''; child.stderr.on('data', c => { error = (error + c).slice(-2000); });
readline.createInterface({ input: child.stdout }).on('line', line => { try { const value = JSON.parse(line); bounds ??= value.bounds; received ??= value.received; } catch {} });
const wait = async fn => { for (let n = 0; n < 100; n++) { if (fn()) return; await delay(100); } throw new Error('GUI fixture timed out: ' + error); };
try {
  await wait(() => bounds); await delay(400);
  const call = args => engine.capabilities.execute('computer', args);
  const status = await call({ action: 'status' }); assert(status.screen && status.accessibility, 'Missing macOS human-granted permission');
  const shot = await call({ action: 'screenshot' }); assert(shot.width > 0 && shot.height > 0);
  await call({ action: 'click', x: bounds.x + 50, y: bounds.y + 75 });
  await call({ action: 'type', text: '中文_DOGO_827' }); await delay(250);
  await call({ action: 'click', x: bounds.x + 90, y: bounds.y + 160 }); await wait(() => received);
  assert.equal(received, '中文_DOGO_827');
  console.log(JSON.stringify({ passed: true, screenshot: shot.path, width: shot.width, height: shot.height, input: received }));
} finally { child.kill('SIGTERM'); await engine.close(); }
