import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { workspacePort } from '../src/workspace-port.mjs';

test('upstream workspace origin is stable, and an occupied port never silently abandons drafts', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'dogo-origin-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const port = await workspacePort(root); assert(port > 1023);
  assert.equal(await workspacePort(root), port);
  const server = createServer().listen(port, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  await assert.rejects(workspacePort(root), /固定端口.*被占用/);
  assert.equal(JSON.parse(await readFile(path.join(root, 'workspace-port.json'), 'utf8')).port, port);
});
