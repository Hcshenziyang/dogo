// Opt-in browser regression with synthetic React data; never connects to a real DogO account.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const { EVAL_NODE_MODULES, EVAL_BROWSER_PATH } = process.env;
if (!EVAL_NODE_MODULES || !EVAL_BROWSER_PATH)
  throw Error('Set EVAL_NODE_MODULES and EVAL_BROWSER_PATH');
const { chromium } = createRequire(import.meta.url)(EVAL_NODE_MODULES + '/playwright-core');
const result = await build({
  entryPoints: ['tests/fixtures/device-ui-harness.mjs'],
  nodePaths: [EVAL_NODE_MODULES],
  bundle: true,
  write: false,
  platform: 'browser',
  format: 'iife',
});
const bundle = result.outputFiles[0].text;
const server = createServer((req, res) => {
  if (req.url === '/bundle.js') {
    res.setHeader('Content-Type', 'text/javascript');
    res.end(bundle);
  } else {
    res.setHeader('Content-Type', 'text/html');
    res.end('<div id="root"></div><script src="/bundle.js"></script>');
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ executablePath: EVAL_BROWSER_PATH, headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.getByRole('button', { name: /测试手机 已登记/ }).waitFor();
  await page.getByRole('button', { name: /活动会话/ }).waitFor();
  assert.equal(await page.getByRole('button', { name: /已归档会话/ }).count(), 0);
  await page.getByLabel('筛选远端项目').selectOption('project');
  assert.equal(await page.getByRole('button', { name: /未分组会话/ }).count(), 0);
  await page.getByRole('button', { name: /活动会话/ }).click();
  await page.locator('.dg-message-user strong').getByText('加粗文字').waitFor();
  assert.equal(await page.locator('.dg-message-user table').count(), 1);
  const expand = page.getByRole('button', { name: '展开这条消息' });
  await expand.waitFor();
  const before = await page
    .locator('.dg-message-user .dg-message-content')
    .evaluate((node) => node.clientHeight);
  await expand.click();
  await page.evaluate(() => {
    window.fixture.addEarlierRecord = true;
  });
  await page.waitForTimeout(3000);
  assert.equal(await page.getByRole('button', { name: '收起这条消息' }).count(), 1);
  const after = await page
    .locator('.dg-message-user .dg-message-content')
    .evaluate((node) => node.clientHeight);
  assert(after > before);
  await page.getByRole('button', { name: '收起这条消息' }).click();
  await page.setViewportSize({ width: 480, height: 850 });
  assert.equal(await page.getByRole('button', { name: '展开这条消息' }).count(), 1);
  await page.evaluate(() => {
    window.fixture.archived = ['archived', 'active'];
  });
  await page
    .locator('.dg-session-row', { hasText: '活动会话' })
    .waitFor({ state: 'detached', timeout: 8000 });
  assert.equal(await page.getByLabel('发送给远程会话').count(), 0);
  await page.evaluate(() => {
    window.fixture.invalid = true;
  });
  await page.getByRole('button', { name: '刷新会话' }).click();
  await page.getByText('暂时无法确认会话状态').first().waitFor();
  assert.equal(await page.getByRole('button', { name: /未分组会话/ }).count(), 0);
  assert.deepEqual(errors, []);
  console.log(
    'PASS: synthetic desktop UI, archive refresh, project filtering, Markdown and long-message folding',
  );
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
