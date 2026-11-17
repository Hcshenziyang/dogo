// Opt-in browser regression with synthetic data; no real DogO account is used.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const { EVAL_NODE_MODULES, EVAL_BROWSER_PATH } = process.env;
if (!EVAL_NODE_MODULES || !EVAL_BROWSER_PATH)
  throw Error('Set EVAL_NODE_MODULES and EVAL_BROWSER_PATH');
const { chromium } = createRequire(import.meta.url)(EVAL_NODE_MODULES + '/playwright-core');
const result = await build({
  entryPoints: ['tests/fixtures/device-settings-harness.mjs'],
  nodePaths: [EVAL_NODE_MODULES],
  bundle: true,
  write: false,
  platform: 'browser',
  format: 'iife',
});
const server = createServer((req, res) => {
  if (req.url === '/bundle.js') {
    res.setHeader('Content-Type', 'text/javascript');
    res.end(result.outputFiles[0].text);
  } else {
    res.setHeader('Content-Type', 'text/html');
    res.end(
      '<style>html,body,#root{height:100%;margin:0}</style><div id="root"></div><script src="/bundle.js"></script>',
    );
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ executablePath: EVAL_BROWSER_PATH, headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 850 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.getByRole('button', { name: 'DogO 设置' }).click();
  const dialog = page.getByRole('dialog', { name: 'DogO 设置' });
  const name = dialog.getByLabel('本机名称');
  const password = dialog.getByLabel('账户密码');
  const save = dialog.getByRole('button', { name: '保存本机名称' });
  assert.equal(await name.inputValue(), '我的电脑');
  assert.equal(await save.isDisabled(), true);
  await name.fill('  书房电脑  ');
  await password.fill('wrong');
  await save.click();
  await dialog.getByText('账户密码不正确，请重试。').waitFor();
  assert.equal(await password.inputValue(), '');
  assert.equal(await page.evaluate(() => window.fixture.devices[0].name), '我的电脑');
  await password.fill('synthetic-password');
  await save.click();
  await dialog.getByText('本机名称已更新，其他设备刷新后可见。').waitFor();
  assert.equal(await name.inputValue(), '书房电脑');
  assert.equal(await password.inputValue(), '');
  assert.equal(await save.isDisabled(), true);
  assert.deepEqual(await page.evaluate(() => window.fixture.devices.map((device) => device.name)), [
    '书房电脑',
    '我的电脑',
  ]);
  const stored = await page.evaluate(() => localStorage.getItem('dogo.login.preferences'));
  assert.equal(JSON.parse(stored).name, '书房电脑');
  assert(!stored.includes('synthetic-password'));
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'DogO 设置' }).click();
  assert.equal(
    await page.getByRole('dialog', { name: 'DogO 设置' }).getByLabel('本机名称').inputValue(),
    '书房电脑',
  );
  await page.setViewportSize({ width: 420, height: 700 });
  assert.equal(
    await page.getByRole('dialog', { name: 'DogO 设置' }).getByLabel('本机名称').isVisible(),
    true,
  );
  assert.deepEqual(errors, []);
  console.log('PASS: device settings rename, wrong password, preference and narrow viewport');
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
