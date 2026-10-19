// Explicit production-relay acceptance with synthetic data, in the dedicated emulator only.
import { readFileSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

if (process.argv[2] !== '--run') throw new Error('Pass --run to send synthetic tasks, notes and memory through the configured relay');
const options = {};
for (let n = 3; n < process.argv.length; n += 2) {
  const key = process.argv[n], value = process.argv[n + 1];
  if (!['--only', '--native-session', '--memory-fixture'].includes(key) || !value || options[key]) throw new Error('Invalid acceptance option');
  options[key] = value;
}
const methods = { native: 'liveContinueNativeUiSession', memory: 'liveMemoryMacToAndroidAndBack', attachment: 'liveChunkedAttachmentAndReceipt', roundtrip: 'liveV2TasksHistoryNotesMemoryAndBackgroundNotification' };
if (options['--only'] && !methods[options['--only']]) throw new Error('Unknown acceptance method');
if (options['--native-session'] && !/^[a-f0-9-]{36}$/.test(options['--native-session'])) throw new Error('Expected a Hub session UUID');
if (options['--memory-fixture'] && !/^acceptance-[A-Za-z0-9-]+\.md$/.test(options['--memory-fixture'])) throw new Error('Only a synthetic acceptance memory file is allowed');
if (options['--only'] === 'native' && !options['--native-session']) throw new Error('Native acceptance requires its prepared session');
if (options['--only'] === 'memory' && !options['--memory-fixture']) throw new Error('Memory acceptance requires its prepared fixture');
const extras = [];
if (options['--native-session']) extras.push('-e', 'dogoNativeSession', options['--native-session']);
if (options['--memory-fixture']) extras.push('-e', 'dogoMemoryFixture', options['--memory-fixture']);
const testClass = 'app.dogo.mobile.HubIntegrationTest' + (options['--only'] ? '#' + methods[options['--only']] : '');
const adb = join(homedir(), 'Library/Android/sdk/platform-tools/adb');
const target = ['-s', 'emulator-5554'];
if (!execFileSync(adb, [...target, 'emu', 'avd', 'name'], { encoding: 'utf8' }).includes('DogO_V1_API_36')) throw new Error('Dedicated DogO test emulator required');
const sandbox = ['shell', 'run-as', 'app.dogo.mobile.devtest'];
execFileSync(adb, [...target, ...sandbox, 'mkdir', '-p', 'files']);
const pairing = readFileSync(join(homedir(), '.local/share/dogo/relay/phone.json'));
let output = '';
try {
  execFileSync(adb, [...target, 'shell', '-T', 'run-as', 'app.dogo.mobile.devtest', 'dd', 'of=files/relay-test-pair.json'], { input: pairing, stdio: ['pipe', 'ignore', 'pipe'] });
  const length = execFileSync(adb, [...target, ...sandbox, 'wc', '-c', 'files/relay-test-pair.json'], { encoding: 'utf8' });
  if (Number(length.trim().split(/\s+/)[0]) !== pairing.length) throw new Error('Private credential transfer incomplete');
  const child = spawn(adb, [...target, 'shell', 'am', 'instrument', '-w', '-r', '-e', 'dogoLiveV2', 'yes', ...extras, '-e', 'class', testClass, 'app.dogo.mobile.devtest.test/androidx.test.runner.AndroidJUnitRunner'], { stdio: ['ignore', 'pipe', 'inherit'] });
  child.stdout.on('data', chunk => { output += chunk; process.stdout.write(chunk); });
  const result = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); });
  const passed = (output.match(/^INSTRUMENTATION_STATUS_CODE: 0\r?$/gm) ?? []).length;
  const skipped = (output.match(/^INSTRUMENTATION_STATUS_CODE: -4\r?$/gm) ?? []).length;
  const expected = options['--only'] ? 1 : 2 + Number(!!options['--native-session']) + Number(!!options['--memory-fixture']);
  if (result !== 0 || !/OK \(\d+ tests?\)/.test(output) || passed !== expected || /FAILURES|INSTRUMENTATION_FAILED/.test(output)) throw new Error('Live Hub instrumentation failed');
  console.log(JSON.stringify({ passed, skipped, physicalPhone: false }));
} finally {
  // Delete only private credentials introduced by this dedicated debug acceptance run.
  execFileSync(adb, [...target, 'shell', 'am', 'force-stop', 'app.dogo.mobile.devtest']);
  execFileSync(adb, [...target, ...sandbox, 'rm', '-f', 'files/relay-test-pair.json', 'files/relay.enc', 'files/relay.enc.bak', 'files/relay.enc.new']);
}
