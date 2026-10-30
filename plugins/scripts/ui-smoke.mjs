// Opt-in test. Two isolated official DSH profiles must have the built packages installed.
import { createRequire } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.EVAL_PLAYWRIGHT_PACKAGE || 'playwright');
const cache = process.env.EVAL_CACHE;
if (!cache || !process.env.EVAL_VIEWER_LOG)
  throw Error('Set isolated EVAL_CACHE and EVAL_VIEWER_LOG');
const url = (await readFile(process.env.EVAL_VIEWER_LOG, 'utf8')).match(
  /http:\/\/127\.0\.0\.1:18186\/\?token=[^\s]+/,
)?.[0];
assert(url);
const account = JSON.parse(await readFile(cache + '/account.json', 'utf8'));
const browser = await chromium.launch({
  headless: true,
  ...(process.env.EVAL_BROWSER_PATH ? { executablePath: process.env.EVAL_BROWSER_PATH } : {}),
});
const errors = [];
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
  let page = await context.newPage();
  page.setDefaultTimeout(10000);
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(url);
  await page.waitForTimeout(1000);
  const welcome = page.getByRole('button', { name: '继续', exact: true });
  await welcome.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
  if (await welcome.isVisible()) await welcome.click();
  const skip = page.getByRole('button', { name: '稍后配置', exact: true });
  await skip.waitFor({ state: 'visible', timeout: 2000 }).catch(() => {});
  if (await skip.isVisible()) await skip.click();
  await page.getByRole('button', { name: 'DogO 备忘录', exact: true }).click();
  const login = page.getByRole('button', { name: '登录', exact: true });
  const signedIn = await page.evaluate(async () => {
    const r = await fetch('/dogo-memos/status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: crypto.randomUUID(),
        method: 'status',
        payload: {},
      }),
    });
    return (await r.json()).result.value.loggedIn;
  });
  if (!signedIn) {
    await page.getByLabel('DogO 服务地址').fill('http://127.0.0.1:18184');
    await page.getByLabel('账户', { exact: true }).fill(account.username);
    await page.getByLabel('密码', { exact: true }).fill(account.password);
    await page.getByText('本机名称 · 我的电脑', { exact: true }).click();
    await page.getByLabel('本机名称', { exact: true }).fill('Viewer A');
    await login.click();
  }
  await page.getByRole('button', { name: 'DogO 设置', exact: true }).waitFor();
  const marker = 'UI_MEMO_' + crypto.randomUUID();
  await page.getByRole('button', { name: '新建', exact: true }).click();
  await page.getByRole('button', { name: '属性', exact: true }).click();
  await page.getByLabel('项目', { exact: true }).fill('ui-eval');
  await page.getByLabel('备忘录内容').fill(marker);
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.getByRole('button', { name: new RegExp(marker) }).waitFor();
  await page.screenshot({ path: cache + '/ui-memos.png' });
  await page.getByRole('button', { name: 'DogO 设备', exact: true }).click();
  await page.getByRole('button', { name: /^Plugin Host B 在线/ }).waitFor();
  // Select B's row, not the viewing computer A. A's receiving switch remains disabled.
  await page.getByRole('button', { name: /^Plugin Host B 在线/ }).click();
  await page
    .getByRole('complementary', { name: '远程会话列表' })
    .getByRole('button', { name: '新建会话', exact: true })
    .click();
  await page.getByLabel('发送给远程会话').waitFor();
  const prompt = 'disconnect-' + crypto.randomUUID();
  await page.getByLabel('发送给远程会话').fill(prompt);
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await page.waitForFunction(
    () => document.querySelector('textarea[aria-label="发送给远程会话"]')?.value === '',
  );
  await page.screenshot({ path: cache + '/ui-devices.png' });
  await page.close();
  await new Promise((r) => setTimeout(r, 2300));
  // A new browser page has no live watcher. B still completes the accepted task.
  page = await context.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(new URL('/', url).href);
  await page.waitForTimeout(1000);
  if (await page.getByRole('button', { name: '继续', exact: true }).count())
    await page.getByRole('button', { name: '继续', exact: true }).click();
  if (await page.getByRole('button', { name: '稍后配置', exact: true }).isVisible())
    await page.getByRole('button', { name: '稍后配置', exact: true }).click();
  await page.getByRole('button', { name: 'DogO 设备', exact: true }).click();
  await page.getByRole('button', { name: /^Plugin Host B 在线/ }).click();
  const state = JSON.parse(await readFile(cache + '/smoke-state.json', 'utf8'));
  const result = await page.evaluate(
    async ({ deviceId }) => {
      const rpc = async (method, payload) => {
        const r = await fetch('/dogo-devices/' + method, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'client-request',
            rpcId: crypto.randomUUID(),
            method,
            payload,
          }),
        });
        return (await r.json()).result;
      };
      const status = await rpc('status', {}),
        list = await rpc('remote', { device_id: deviceId, method: 'list', args: {} });
      return { status, list };
    },
    { deviceId: state.deviceId },
  );
  assert.notEqual(result.status.value.deviceId, state.deviceId);
  assert(result.list.ok);
  let completed = false,
    chosen;
  for (const s of result.list.value.value.items) {
    const snap = await page.evaluate(
      async ({ deviceId, sessionId }) =>
        (
          await (
            await fetch('/dogo-devices/remote', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                type: 'client-request',
                rpcId: crypto.randomUUID(),
                method: 'remote',
                payload: { device_id: deviceId, method: 'snapshot', args: { sessionId } },
              }),
            })
          ).json()
        ).result,
      { deviceId: state.deviceId, sessionId: s.sessionId },
    );
    if (JSON.stringify(snap).includes('EVAL_REPLY:' + prompt)) {
      completed = true;
      chosen = s;
      break;
    }
  }
  assert(completed);
  await page
    .getByRole('button', {
      name: chosen.projections?.values?.title || chosen.title || '新会话',
      exact: false,
    })
    .click();
  await page.getByText('EVAL_REPLY:' + prompt, { exact: true }).waitFor();
  await page.screenshot({ path: cache + '/ui-remote-history.png' });
  assert.deepEqual(errors, []);
  const results = [
    'official-sidebar-and-main-panels',
    'viewer-ui-login-and-memo-write',
    'distinct-viewer-A-creates-and-prompts-on-B',
    'B-completes-after-viewer-page-closes',
    'no-browser-page-errors',
  ].map((test) => ({ test, passed: true }));
  await writeFile(cache + '/ui-results.json', JSON.stringify(results, null, 2));
  console.log('PASS', results.map((x) => x.test).join(', '));
} catch (e) {
  console.error(String(e).split('Call log:')[0]);
  throw e;
} finally {
  await browser.close();
}
