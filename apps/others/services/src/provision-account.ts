import { readFileSync, openSync, writeFileSync, closeSync, unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { configSchema } from './schema.ts';
import { Store } from './store.ts';
import { AccountService } from './auth.ts';

// Local-only admin command: secrets come from stdin, never argv, logs or tracked config.
process.umask(0o077);
let output: number | undefined;
let recoveryPath: string | undefined;
let store: Store | undefined;
let committed = false;
try {
  const configPath = process.env.DOGO_CONFIG;
  if (!configPath || process.argv.length !== 3 || process.stdin.isTTY)
    throw new Error('Set DOGO_CONFIG; pipe {username,password} JSON through stdin; pass a new private recovery-file path');
  const config = configSchema.parse(JSON.parse(readFileSync(configPath, 'utf8')));
  config.database = resolve(dirname(resolve(configPath)), config.database);
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
    if (Buffer.byteLength(input) > 4096) throw new Error('Input too large');
  }
  recoveryPath = resolve(process.argv[2]!);
  output = openSync(recoveryPath, 'wx', 0o600);
  store = new Store(config);
  const account = new AccountService(store, []);
  const result = await account.provision(JSON.parse(input));
  committed = true;
  writeFileSync(output, JSON.stringify(result) + '\n');
  console.log('Personal account created. Recovery information saved to the private output file. Public registration remains disabled.');
} catch (error) {
  // Do not print validation objects: they may include supplied secrets.
  console.error(committed ? 'Account created but recovery-file write failed; server administrator action required.' : 'Account creation failed. Check configuration, input, existing account and output-file permissions.');
  process.exitCode = 1;
} finally {
  if (output !== undefined) { closeSync(output); if (!committed && recoveryPath) unlinkSync(recoveryPath); }
  store?.db.close();
}
