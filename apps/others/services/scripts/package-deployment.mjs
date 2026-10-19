import { mkdirSync, existsSync, writeFileSync, readFileSync, cpSync, chmodSync } from 'node:fs';
import { randomBytes, createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

// Generated credentials are private deployment artifacts, never source or APK assets.
const scripts = dirname(fileURLToPath(import.meta.url));
const [packagePath, hostname] = process.argv.slice(2);
if (!packagePath || !/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(hostname ?? ''))
  throw new Error('Usage: node package-deployment.mjs <pnpm deploy directory> <hostname>');
// Verify the new shared dependency before generating or copying any private credentials.
execFileSync(process.execPath, ['--input-type=module', '-e', 'await import("@dogo/sync-client/schema")'], { cwd: resolve(packagePath), stdio: 'pipe' });
const privateRoot = join(homedir(), '.local/share/dogo/relay');
mkdirSync(privateRoot, { recursive: true, mode: 0o700 });
chmodSync(privateRoot, 0o700);
const origin = `https://${hostname}`;
const keys = {};
for (const device of ['mac', 'phone']) {
  const file = join(privateRoot, `${device}.json`);
  if (!existsSync(file)) writeFileSync(file, JSON.stringify({ version: 1, url: origin, device,
    token: randomBytes(32).toString('base64url') }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  const key = JSON.parse(readFileSync(file, 'utf8'));
  if (key.url !== origin || key.device !== device || !/^[\w-]{43}$/.test(key.token))
    throw new Error(`Existing ${device} credential does not match; will not overwrite`);
  chmodSync(file, 0o600);
  keys[device] = key.token;
}
const stage = join(privateRoot, `deployment-${Date.now()}`);
mkdirSync(stage, { mode: 0o700 });
cpSync(resolve(packagePath), join(stage, 'app'), { recursive: true, verbatimSymlinks: true });
cpSync(join(scripts, 'deploy-server.sh'), join(stage, 'deploy-server.sh'));
cpSync(join(scripts, 'backup.mjs'), join(stage, 'backup.mjs'));
writeFileSync(join(stage, 'credentials.env'),
  `DOGO_MAC_TOKEN=${keys.mac}\nDOGO_PHONE_TOKEN=${keys.phone}\n`, { mode: 0o600, flag: 'wx' });
const archive = join(privateRoot, 'dogo-relay-deploy.tar.gz');
execFileSync('/usr/bin/tar', [...(process.platform === 'darwin' ? ['--no-xattrs'] : []), '-czf', archive, '-C', stage, '.'], {
  env: { ...process.env, COPYFILE_DISABLE: '1' },
});
chmodSync(archive, 0o600);
console.log(JSON.stringify({ archive, sha256: createHash('sha256').update(readFileSync(archive)).digest('hex'),
  credentials: ['mac.json', 'phone.json'].map(name => join(privateRoot, name)) }, null, 2));
