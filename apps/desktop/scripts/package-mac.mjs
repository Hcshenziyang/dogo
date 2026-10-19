import { cp, mkdir, readFile, writeFile, rename, access, mkdtemp, unlink, symlink, readdir, realpath } from 'node:fs/promises';
import { createRequire, stripTypeScriptTypes } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';

if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('This build targets Apple Silicon macOS only');
const root = fileURLToPath(new URL('../../../', import.meta.url));
const { version: appVersion } = JSON.parse(await readFile(path.join(root, 'apps/desktop/package.json'), 'utf8'));
const require = createRequire(import.meta.url);
const electron = require('electron');
const runtime = await mkdtemp(path.join(os.tmpdir(), 'dogo-mac-package-'));
const run = (command, args, cwd = root) => { const result = spawnSync(command, args, { cwd, stdio: 'inherit' }); if (result.status !== 0) throw new Error(`${command} failed`); };
run('pnpm', ['--config.verify-deps-before-run=false', '--filter', '@dogo/web', 'build']);
run('pnpm', ['--filter', '@dogo/runtime', 'deploy', '--legacy', '--prod', path.join(runtime, 'runtime')]);
const target = path.join(root, 'apps/desktop/release', `DogO-${appVersion}-${Date.now()}.app`);
await mkdir(path.dirname(target), { recursive: true });
await cp(path.resolve(electron, '../../..'), target, { recursive: true, verbatimSymlinks: true });
const contents = path.join(target, 'Contents');
const appRoot = path.join(contents, 'Resources/app');
await mkdir(path.join(contents, 'Resources/native'), { recursive: true });
run('xcrun', ['swiftc', '-parse-as-library', '-O', path.join(root, 'apps/desktop/native/Computer.swift'), '-o', path.join(contents, 'Resources/native/dogo-computer')]);
await mkdir(path.join(appRoot, 'apps'), { recursive: true });
await cp(path.join(runtime, 'runtime'), path.join(appRoot, 'apps/runtime'), { recursive: true, verbatimSymlinks: true });
// pnpm legacy deploy leaves the root self-link pointing back at the build checkout.
const selfLink = path.join(appRoot, 'apps/runtime/node_modules/.pnpm/node_modules/@dogo/runtime');
await unlink(selfLink).catch(error => { if (error.code !== 'ENOENT') throw error; });
await symlink('../../../..', selfLink);
// Node deliberately refuses TypeScript stripping inside node_modules. Compile the
// workspace service dependency in the distributable, without changing source files.
const serviceRoot = await realpath(path.join(appRoot, 'apps/runtime/node_modules/@dogo/services'));
for (const file of await readdir(path.join(serviceRoot, 'src'))) {
  if (!file.endsWith('.ts')) continue;
  const source = await readFile(path.join(serviceRoot, 'src', file), 'utf8');
  const javascript = stripTypeScriptTypes(source).replace(/(from\s+['"]\.\/[^'"\n]+)\.ts(['"])/g, '$1.js$2');
  await writeFile(path.join(serviceRoot, 'src', file.replace(/\.ts$/, '.js')), javascript);
}
const servicePackagePath = path.join(serviceRoot, 'package.json');
const servicePackage = JSON.parse(await readFile(servicePackagePath, 'utf8'));
servicePackage.exports = Object.fromEntries(Object.entries(servicePackage.exports).map(([key, value]) => [key, value.replace(/\.ts$/, '.js')]));
await writeFile(servicePackagePath, JSON.stringify(servicePackage));
await cp(path.join(root, 'apps/desktop/src'), path.join(appRoot, 'apps/desktop/src'), { recursive: true });
await cp(path.join(root, 'apps/web/dist'), path.join(appRoot, 'apps/web/dist'), { recursive: true });
await writeFile(path.join(appRoot, 'package.json'), JSON.stringify({ name: 'dogo', productName: 'DogO', version: appVersion, type: 'module', main: 'apps/desktop/src/main.mjs' }));
// Official standalone Node distribution: self-contained app, no Homebrew dependency at login.
const version = '24.22.0';
const archiveName = `node-v${version}-darwin-arm64.tar.gz`;
const base = `https://nodejs.org/dist/v${version}/`;
const sums = await fetch(base + 'SHASUMS256.txt', { signal: AbortSignal.timeout(45000) }).then(r => { if (!r.ok) throw new Error('Node manifest unavailable'); return r.text(); });
const expected = sums.split('\n').find(line => line.endsWith('  ' + archiveName))?.split(' ')[0];
if (!expected) throw new Error('Official Node checksum missing');
// An explicit cached archive is still checked against the current official manifest.
const bytes = process.env.DOGO_NODE_ARCHIVE ? await readFile(path.resolve(process.env.DOGO_NODE_ARCHIVE))
  : Buffer.from(await fetch(base + archiveName, { signal: AbortSignal.timeout(180000) }).then(r => { if (!r.ok) throw new Error('Node download failed'); return r.arrayBuffer(); }));
if (createHash('sha256').update(bytes).digest('hex') !== expected) throw new Error('Node checksum mismatch');
const archive = path.join(runtime, archiveName); await writeFile(archive, bytes);
run('tar', ['-xzf', archive, '-C', path.join(contents, 'Resources')]);
await rename(path.join(contents, 'Resources', `node-v${version}-darwin-arm64`), path.join(contents, 'Resources/node'));
// Check the installed dependency graph, not just the development checkout.
run(path.join(contents, 'Resources/node/bin/node'), ['--input-type=module', '-e', 'await import("./apps/runtime/src/engine.mjs")'], appRoot);
const plist = path.join(contents, 'Info.plist');
await rename(path.join(contents, 'MacOS/Electron'), path.join(contents, 'MacOS/DogO'));
for (const [key, value] of Object.entries({ CFBundleExecutable: 'DogO', CFBundleIdentifier: 'app.dogo.desktop', CFBundleName: 'DogO', CFBundleDisplayName: 'DogO', CFBundleShortVersionString: appVersion, CFBundleVersion: '5' }))
  run('/usr/libexec/PlistBuddy', ['-c', `Set :${key} ${value}`, plist]);
run('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', target]);
run('/usr/bin/codesign', ['--verify', '--deep', '--strict', target]);
await access(path.join(contents, 'Resources/node/bin/node'));
console.log(`Built local ad-hoc signed app: ${target}\nNot notarized for distribution; no credentials or user data included.`);
