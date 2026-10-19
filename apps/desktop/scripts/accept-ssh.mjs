// Real SSH protocol acceptance against a disposable loopback-only daemon, never a production server.
import { mkdtemp, readFile, writeFile, mkdir, chmod } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';
import { Engine } from '../../../packages/dsh-plugin/test/harness.mjs';
import { runProcess } from '../src/native/process.mjs';
if (!process.argv.includes('--run')) throw new Error('Pass --run for a temporary loopback SSH fixture');
const root = await mkdtemp(path.join(tmpdir(), 'dogo-ssh-acceptance-'));
await chmod(root, 0o700);
const host = path.join(root, 'host'), client = path.join(root, 'client');
for (const file of [host, client]) { const key = await runProcess('/usr/bin/ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', file]); assert.equal(key.code, 0, key.stderr); }
const socket = net.createServer(); socket.listen(0, '127.0.0.1'); await once(socket, 'listening'); const port = socket.address().port; await new Promise(r => socket.close(r));
const username = userInfo().username, daemonConfig = path.join(root, 'sshd.conf'), clientConfig = path.join(root, 'ssh.conf');
await writeFile(daemonConfig, `ListenAddress 127.0.0.1\nPort ${port}\nHostKey ${host}\nPidFile ${root}/sshd.pid\nAuthorizedKeysFile ${client}.pub\nStrictModes no\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nUsePAM no\nAllowUsers ${username}\nAllowTcpForwarding no\nAllowAgentForwarding no\nX11Forwarding no\nPermitTunnel no\n`, { mode: 0o600 });
const publicHost = (await readFile(host + '.pub', 'utf8')).trim().split(' ').slice(0, 2).join(' ');
await writeFile(path.join(root, 'known_hosts'), `[127.0.0.1]:${port} ${publicHost}\n`, { mode: 0o600 });
await writeFile(clientConfig, `Host fixture\n HostName 127.0.0.1\n Port ${port}\n User ${username}\n IdentityFile ${client}\n IdentitiesOnly yes\n UserKnownHostsFile ${root}/known_hosts\n StrictHostKeyChecking yes\n`, { mode: 0o600 });
const daemon = spawn('/usr/sbin/sshd', ['-D', '-e', '-f', daemonConfig], { stdio: ['ignore', 'ignore', 'pipe'] });
let daemonError = ''; daemon.stderr.on('data', chunk => { daemonError = (daemonError + chunk).slice(-4000); });
const engine = new Engine(path.join(root, 'dogo'));
try {
  await delay(500); if (daemon.exitCode !== null) throw new Error('Loopback sshd unavailable: ' + daemonError);
  await engine.capabilities.configure({ computer: false, codex: false, sshHosts: ['fixture'] });
  engine.capabilities.run = (command, args, options) => runProcess(command, ['-F', clientConfig, ...args], options);
  const result = await engine.capabilities.execute('ssh', { host: 'fixture', command: 'printf DOGO_SSH_FIXTURE_731', timeoutSeconds: 10 });
  assert(result.success, JSON.stringify({ result, daemonError })); assert.equal(result.stdout, 'DOGO_SSH_FIXTURE_731');
  const failure = await engine.capabilities.execute('ssh', { host: 'fixture', command: 'exit 7', timeoutSeconds: 10 }); assert.equal(failure.code, 7); assert.equal(failure.success, false);
  console.log(JSON.stringify({ passed: true, loopbackOnly: true, root, resultPath: result.resultPath, failedExitCode: failure.code }));
} finally { daemon.kill('SIGTERM'); await engine.close(); }
