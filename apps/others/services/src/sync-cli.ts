import { setTimeout } from 'node:timers/promises';
import { ServiceClient } from './client.ts';
import { syncFolder } from './sync.ts';

const { DOGO_URL, DOGO_TOKEN, DOGO_SHARED_DIR } = process.env;
if (!DOGO_URL || !DOGO_TOKEN || !DOGO_SHARED_DIR) throw new Error('Set DOGO_URL, DOGO_TOKEN and DOGO_SHARED_DIR explicitly');
const client = new ServiceClient(DOGO_URL, DOGO_TOKEN);
const watch = process.argv.includes('--watch');
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { stopping = true; });
do {
  try {
    const report = await syncFolder(client, DOGO_SHARED_DIR);
    console.log(JSON.stringify(report));
    if (!watch && report.conflicts.length) process.exitCode = 2;
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Sync failed');
    if (!watch) process.exitCode = 1;
  }
  if (!watch || stopping) break;
  await setTimeout(10_000);
} while (!stopping);
