import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
const destination = resolve('release');
await mkdir(destination, { recursive: true });
for (const name of ['memos', 'devices']) {
  const result = spawnSync('pnpm', ['pack', '--pack-destination', destination], {
    cwd: resolve(name),
    stdio: 'inherit',
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
