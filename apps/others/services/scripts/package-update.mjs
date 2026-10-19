// Code-only archive for the existing server. Copies an allowlist, never configuration or data.
import { cp, mkdir, mkdtemp, readFile, writeFile, readdir, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
const service = fileURLToPath(new URL('..', import.meta.url)), root = path.resolve(service, '../../..');
const output = path.resolve(process.argv[2] ?? '');
if (!process.argv[2] || !output.endsWith('.tgz')) throw new Error('Pass a new .tgz output path');
await access(output).then(() => { throw new Error('Output already exists'); }, e => { if (e.code !== 'ENOENT') throw e; });
const built = spawnSync(process.execPath, [path.join(root, 'packages/sync-client/scripts/build.mjs')], { stdio: 'inherit' });
if (built.status !== 0) throw new Error('Shared sync client build failed');
const staging = await mkdtemp(path.join(os.tmpdir(), 'dogo-update-'));
for (const name of ['src', 'test', 'scripts', 'package.json']) await cp(path.join(service, name), path.join(staging, name), { recursive: true });
// Existing deployments already contain zod; include the new shared JS without requiring workspace links.
await cp(path.join(root, 'packages/sync-client/dist'), path.join(staging, 'shared-sync'), { recursive: true });
for (const name of ['client', 'sync', 'schema']) {
  const file = path.join(staging, 'src', name + '.ts');
  const source = await readFile(file, 'utf8');
  await writeFile(file, source.replace(/@dogo\/sync-client\/(client|sync|schema)/g, '../shared-sync/$1.mjs'));
}
const manifest = JSON.parse(await readFile(path.join(staging, 'package.json'), 'utf8'));
delete manifest.dependencies['@dogo/sync-client'];
Object.assign(manifest.scripts, { start: 'node src/main.ts', sync: 'node src/sync-cli.ts', test: 'node --test test/*.test.ts' });
await writeFile(path.join(staging, 'package.json'), JSON.stringify(manifest, null, 2));
await cp(path.join(root, 'apps/mobile/dist'), path.join(staging, 'web'), { recursive: true });
await access(path.join(staging, 'web/index.html'));
// Keep integration tests standalone on the server without shipping the entire monorepo or TypeScript in node_modules.
await mkdir(path.join(staging, 'test-clients'));
for (const file of ['client.ts', 'browser.ts', 'account-types.ts']) await cp(path.join(root, 'packages/hub-ui/src', file), path.join(staging, 'test-clients', file));
for (const file of await readdir(path.join(staging, 'test'))) if (file.endsWith('.ts')) {
  const target = path.join(staging, 'test', file);
  const source = await readFile(target, 'utf8');
  await writeFile(target, source.replaceAll('../../../../packages/hub-ui/src/', '../test-clients/'));
}
const result = spawnSync('tar', ['-czf', output, '-C', staging, 'src', 'test', 'test-clients', 'shared-sync', 'scripts', 'package.json', 'web'], { stdio: 'inherit' });
if (result.status !== 0) throw new Error('Archive creation failed');
console.log(JSON.stringify({ archive: output, sha256: createHash('sha256').update(await readFile(output)).digest('hex'), staging, secretsIncluded: false }));
