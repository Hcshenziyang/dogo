import { cp, mkdir, readFile, writeFile, rename, access, mkdtemp, unlink, symlink } from 'node:fs/promises';
import { createRequire } from 'node:module';
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
run('pnpm', ['--filter', '@dogo/dsh-plugin', 'build']);
run('pnpm', ['--config.verify-deps-before-run=false', '--filter', '@dogo/web', 'build']);
run('pnpm', ['--filter', '@dogo/desktop', 'deploy', '--legacy', '--prod', path.join(runtime, 'desktop')]);
const target = path.join(root, 'apps/desktop/release', `DogO-${appVersion}-${Date.now()}.app`);
await mkdir(path.dirname(target), { recursive: true });
await cp(path.resolve(electron, '../../..'), target, { recursive: true, verbatimSymlinks: true });
const contents = path.join(target, 'Contents');
// Build every standard/Retina representation from the selected DogO artwork.
const iconset = path.join(runtime, 'DogO.iconset');
await mkdir(iconset);
for (const size of [16, 32, 128, 256, 512]) {
  for (const scale of [1, 2]) {
    const pixels = String(size * scale);
    run('/usr/bin/sips', ['-z', pixels, pixels, path.join(root, 'apps/desktop/assets/icon.png'), '--out',
      path.join(iconset, `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`)]);
  }
}
run('/usr/bin/iconutil', ['-c', 'icns', iconset, '-o', path.join(contents, 'Resources/DogO.icns')]);
const appRoot = path.join(contents, 'Resources/app');
await mkdir(path.join(contents, 'Resources/native'), { recursive: true });
run('xcrun', ['swiftc', '-parse-as-library', '-O', path.join(root, 'apps/desktop/native/Computer.swift'), '-o', path.join(contents, 'Resources/native/dogo-computer')]);
await mkdir(path.join(appRoot, 'apps'), { recursive: true });
await cp(path.join(runtime, 'desktop'), path.join(appRoot, 'apps/desktop'), { recursive: true, verbatimSymlinks: true });
// pnpm legacy deploy leaves the root self-link pointing back at the build checkout.
const selfLink = path.join(appRoot, 'apps/desktop/node_modules/.pnpm/node_modules/@dogo/desktop');
await unlink(selfLink).catch(error => { if (error.code !== 'ENOENT') throw error; });
await symlink('../../../..', selfLink);
// Workspace dependencies ship prebuilt JS; no runtime TS stripping inside node_modules.
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
run(path.join(contents, 'Resources/node/bin/node'), ['--input-type=module', '-e', 'await import("./apps/desktop/src/host/client.mjs")'], appRoot);
const plist = path.join(contents, 'Info.plist');
await rename(path.join(contents, 'MacOS/Electron'), path.join(contents, 'MacOS/DogO'));
for (const [key, value] of Object.entries({ CFBundleExecutable: 'DogO', CFBundleIdentifier: 'app.dogo.desktop', CFBundleName: 'DogO', CFBundleDisplayName: 'DogO', CFBundleIconFile: 'DogO.icns', CFBundleShortVersionString: appVersion, CFBundleVersion: '5' }))
  run('/usr/libexec/PlistBuddy', ['-c', `Set :${key} ${value}`, plist]);
run('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', target]);
run('/usr/bin/codesign', ['--verify', '--deep', '--strict', target]);
await access(path.join(contents, 'Resources/node/bin/node'));
console.log(`Built local ad-hoc signed app: ${target}\nNot notarized for distribution; no credentials or user data included.`);
