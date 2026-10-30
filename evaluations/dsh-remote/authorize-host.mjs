// Exchange only the isolated DSH launch token, then authorize its Host locally.
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const cache = process.env.EVAL_CACHE;
if (!cache || !process.env.EVAL_DSH_LOG) throw Error('Set EVAL_CACHE and EVAL_DSH_LOG');
const log = await readFile(process.env.EVAL_DSH_LOG, 'utf8');
const url = log.match(/http:\/\/127\.0\.0\.1:18181\/\?token=[^\s]+/)?.[0];
if (!url) throw Error('No isolated DSH launch URL');
const response = await fetch(url, { redirect: 'manual' });
const cookie = response.headers.get('set-cookie')?.split(';')[0];
if (!cookie) throw Error('No browser cookie');
await writeFile(join(cache, 'browser-cookie'), cookie, { mode: 0o600 });
const credentials = JSON.parse(await readFile(join(cache, 'fixture-account.json'), 'utf8'));
const method = 'host.account.login';
const result = await (await fetch('http://127.0.0.1:18181/ds-harness-remote/' + method, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
  body: JSON.stringify({ type: 'client-request', rpcId: 'authorize-evaluation-host', method, payload: { email: credentials.account, password: credentials.password } }),
})).json();
if (!result.result?.ok) throw Error(JSON.stringify(result.result?.error));
console.log('PASS isolated Host authorized; credentials omitted');
