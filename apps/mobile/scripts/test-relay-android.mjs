import { readFileSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Only the dedicated emulator/debug sandbox; never a physical phone or the release app.
const adb = join(homedir(), 'Library/Android/sdk/platform-tools/adb');
const target = ['-s', 'emulator-5554'];
const avd = execFileSync(adb, [...target, 'emu', 'avd', 'name'], { encoding: 'utf8' });
if (!avd.includes('DogO_V1_API_36')) throw new Error('Dedicated DogO test emulator required');
execFileSync(adb, [...target, 'shell', 'run-as', 'app.dogo.mobile.devtest', 'mkdir', '-p', 'files']);
const pairing = readFileSync(join(homedir(), '.local/share/dogo/relay/phone.json'));
execFileSync(adb, [...target, 'shell', '-T', 'run-as', 'app.dogo.mobile.devtest', 'dd', 'of=files/relay-test-pair.json'], {
  input: pairing,
  stdio: ['pipe', 'ignore', 'pipe'],
});
const transferred = execFileSync(adb, [...target, 'shell', 'run-as', 'app.dogo.mobile.devtest', 'wc', '-c', 'files/relay-test-pair.json'], { encoding: 'utf8' });
if (Number(transferred.trim().split(/\s+/)[0]) !== pairing.length) throw new Error('Private test credential transfer incomplete');
const child = spawn(adb, [...target, 'shell', 'am', 'instrument', '-w', '-r', '-e', 'dogoLive', 'yes',
  'app.dogo.mobile.devtest.test/androidx.test.runner.AndroidJUnitRunner'], { stdio: ['ignore', 'pipe', 'inherit'] });
let result = '';
child.stdout.on('data', chunk => { result += chunk; process.stdout.write(chunk); });
child.on('exit', code => {
  // Remove only credentials created by this test inside its isolated debug sandbox.
  execFileSync(adb, [...target, 'shell', 'run-as', 'app.dogo.mobile.devtest', 'rm', '-f',
    'files/relay-test-pair.json', 'files/relay.enc', 'files/relay.enc.bak', 'files/relay.enc.new']);
  process.exitCode = code === 0 && /OK \(3 tests\)/.test(result) ? 0 : 1;
});
