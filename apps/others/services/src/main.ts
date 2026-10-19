import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { configSchema } from './schema.ts';
import { createService } from './server.ts';

const configPath = process.env.DOGO_CONFIG;
if (!configPath) throw new Error('Set DOGO_CONFIG to an explicit service configuration JSON path');
const config = configSchema.parse(JSON.parse(readFileSync(configPath, 'utf8')));
config.database = resolve(dirname(resolve(configPath)), config.database);
process.umask(0o077);
const service = createService(config);
console.log(`DogO services listening at ${await service.listen()} (${config.services.join(', ')})`);
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => {
  if (stopping) return;
  stopping = true;
  void service.close().catch(() => { process.exitCode = 1; });
});
