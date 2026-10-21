import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { createService } from '../src/server.ts';
import { ServiceClient } from '../src/client.ts';
import { configSchema } from '../src/schema.ts';

export const env = { DOGO_MAC_TOKEN: 'm'.repeat(48), DOGO_PHONE_TOKEN: 'p'.repeat(48), DOGO_WIN_TOKEN: 'w'.repeat(48) };
export function config(database = ':memory:') {
  return configSchema.parse({ database, port: 0,
    devices: [
      { id: 'mac', tokenEnv: 'DOGO_MAC_TOKEN', publishTo: ['/tasks/phone'], memory: true },
      { id: 'phone', tokenEnv: 'DOGO_PHONE_TOKEN', publishTo: ['/tasks/mac'], memory: true },
      { id: 'win', tokenEnv: 'DOGO_WIN_TOKEN', publishTo: [], memory: false },
    ],
    mailboxes: { '/tasks/mac': 'mac', '/tasks/phone': 'phone', '/tasks/win': 'win' },
  });
}

export function temp() {
  const root = mkdtempSync(join(tmpdir(), 'dogo-services-test-'));
  return root;
}

export async function fixture(t: TestContext) {
  const root = temp();
  let now = 100_000;
  const service = createService(config(join(root, 'service.sqlite')), env, () => now);
  const url = await service.listen();
  t.after(async () => {
    await service.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { root, service, url, setTime: (value: number) => { now = value; },
    mac: new ServiceClient(url, env.DOGO_MAC_TOKEN), phone: new ServiceClient(url, env.DOGO_PHONE_TOKEN),
    win: new ServiceClient(url, env.DOGO_WIN_TOKEN) };
}

export const taskInput = { requestId: 'phone-task-1', mailbox: '/tasks/mac', title: 'Read code', instructions: 'Inspect only; return findings.' };

/** Synthetic owner provisioning is local administration, followed by ordinary login. */
export async function provisionLogin(account: import('../src/auth.ts').AccountService, data: any, migration?: import('../src/auth.ts').Principal) {
  const { recoveryCode } = await account.provision({ username: data.username, password: data.password });
  return { ...await account.login(data, 'fixture-owner', false, migration), recoveryCode };
}
