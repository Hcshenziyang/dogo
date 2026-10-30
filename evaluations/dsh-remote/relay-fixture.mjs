// Evaluation only: local relay, disposable account, no production credentials.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

const cache = process.env.EVAL_CACHE;
const upstream = process.env.EVAL_UPSTREAM;
if (!cache || !upstream) throw new Error('Set EVAL_CACHE and EVAL_UPSTREAM');
await mkdir(cache, { recursive: true });
let credentials;
try { credentials = JSON.parse(await readFile(join(cache, 'fixture-account.json'), 'utf8')); }
catch (e) {
  if (e.code !== 'ENOENT') throw e;
  credentials = { account: 'evaluation@example.test', password: randomBytes(24).toString('hex') };
  await writeFile(join(cache, 'fixture-account.json'), JSON.stringify(credentials), { mode: 0o600 });
}
const { createRemoteServer } = await import(pathToFileURL(join(upstream, 'apps/server/src/server.ts')));
const relay = createRemoteServer({ ...credentials, publicUrl: 'http://127.0.0.1:18180', dataFile: join(cache, 'relay-state.json') });
relay.server.listen(18180, '127.0.0.1', () => console.log('Evaluation relay listening on loopback:18180'));
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await relay.close(); process.exit(0); });
