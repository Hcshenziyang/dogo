// Opt-in regression against an isolated DSH, never a personal profile.
import { readFile, realpath, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';

const {
  EVAL_DSH_HOME: home,
  EVAL_DSH_LOG: logFile,
  EVAL_PLAYWRIGHT_PACKAGE,
  EVAL_BROWSER_PATH,
} = process.env;
if (!home || !logFile || !isAbsolute(home) || !EVAL_PLAYWRIGHT_PACKAGE) {
  throw Error('Set EVAL_DSH_HOME, EVAL_DSH_LOG and EVAL_PLAYWRIGHT_PACKAGE for an isolated DSH.');
}
const realHome = await realpath(home);
const safeRoots = await Promise.all(['/tmp', tmpdir()].map((p) => realpath(p)));
if (!safeRoots.some((p) => realHome.startsWith(p + sep)))
  throw Error('The isolated DSH home must be under a temporary directory.');
const log = await readFile(logFile, 'utf8');
const url = log.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+/)?.[0];
if (!url) throw Error('The isolated DSH log does not contain a loopback launch URL.');
const require = createRequire(import.meta.url);
const { chromium } = require(EVAL_PLAYWRIGHT_PACKAGE);
const browser = await chromium.launch({
  headless: true,
  ...(EVAL_BROWSER_PATH ? { executablePath: EVAL_BROWSER_PATH } : {}),
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.setDefaultTimeout(12000);
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
const suffix = randomUUID().slice(0, 8);
const note = '回归笔记-' + suffix,
  canvas = '回归画布-' + suffix;
const root = join(resolve(home), 'dogo', 'knowledge');
const exists = async (file) => {
  try {
    await stat(file);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
};
try {
  await page.addInitScript(() => {
    window.prompt = () => {
      throw Error('prompt() is not supported');
    };
    window.confirm = () => {
      throw Error('confirm() is not supported');
    };
  });
  await page.goto(url);
  await page.waitForTimeout(1800);
  const welcome = page.getByRole('button', { name: '继续', exact: true });
  if (await welcome.count()) await welcome.click();
  const startupDialog = page.getByRole('dialog').first();
  if (await startupDialog.count()) {
    const close = startupDialog.getByRole('button', { name: '关闭' });
    if (await close.count()) await close.click();
  }
  await page.getByText('知识工作区', { exact: true }).first().click();
  await page.getByLabel('笔记正文').waitFor();
  const shownDirectory = await page.locator('.dw-tree-foot').getAttribute('title');
  if (shownDirectory !== root)
    throw Error('The connected workspace does not belong to EVAL_DSH_HOME.');
  for (const [label, dialogName, inputName, title, file] of [
    ['+ 笔记', '新建笔记', '新笔记名称', note, join(root, note + '.md')],
    ['+ 画布', '新建画布', '新画布名称', canvas, join(root, canvas + '.canvas')],
  ]) {
    await page.getByRole('button', { name: label, exact: true }).click();
    const dialog = page.getByRole('dialog', { name: dialogName });
    const input = dialog.getByLabel(inputName);
    await input.fill(title);
    await input.press('Enter');
    await dialog.waitFor({ state: 'hidden' });
    assert.equal(await exists(file), true);
  }
  const confirmDelete = async () => {
    await page.getByRole('button', { name: '删除', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '删除内容？' });
    await dialog.getByRole('button', { name: '删除', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
  };
  await page.getByRole('button', { name: '删除', exact: true }).click();
  await page
    .getByRole('dialog', { name: '删除内容？' })
    .getByRole('button', { name: '取消' })
    .click();
  assert.equal(await exists(join(root, canvas + '.canvas')), true);
  await confirmDelete();
  assert.equal(await exists(join(root, canvas + '.canvas')), false);
  await page.locator('.dw-tree .dw-entry').filter({ hasText: note }).click();
  await page.waitForFunction(
    (name) => document.querySelector('[aria-label="笔记正文"]')?.textContent?.includes(name),
    note,
  );
  await confirmDelete();
  assert.equal(await exists(join(root, note + '.md')), false);
  const opener = page.getByRole('button', { name: '+ 笔记', exact: true });
  await opener.click();
  const cancelDialog = page.getByRole('dialog', { name: '新建笔记' });
  await cancelDialog.waitFor();
  await page.keyboard.press('Escape');
  await cancelDialog.waitFor({ state: 'hidden' });
  assert.equal(await opener.evaluate((el) => document.activeElement === el), true);
  await page.evaluate(() => document.documentElement.setAttribute('data-platform', 'darwin'));
  await page.locator('[data-sidebar-toggle]:visible').first().click();
  await page.locator('[data-shell-leading]').waitFor();
  await page.waitForTimeout(500);
  const geometry = await page.evaluate(() => {
    const label = document.querySelector('.dw-head .dw-dim').getBoundingClientRect();
    const shell = document.querySelector('[data-shell-leading]').getBoundingClientRect();
    const frame = document.querySelector('[data-sidebar-collapsed]');
    return {
      left: label.left,
      shellRight: shell.right,
      clearance: getComputedStyle(frame).getPropertyValue('--dsh-frame-leading-clearance').trim(),
    };
  });
  assert.equal(geometry.clearance, '160px');
  assert(geometry.left >= 160 && geometry.left >= geometry.shellRight);
  await page.evaluate(() => document.documentElement.setAttribute('data-fullscreen', ''));
  const fullscreen = await page.evaluate(() => {
    const label = document.querySelector('.dw-head .dw-dim').getBoundingClientRect();
    const shell = document.querySelector('[data-shell-leading]').getBoundingClientRect();
    const frame = document.querySelector('[data-sidebar-collapsed]');
    return {
      left: label.left,
      shellRight: shell.right,
      clearance: getComputedStyle(frame).getPropertyValue('--dsh-frame-leading-clearance').trim(),
    };
  });
  assert.equal(fullscreen.clearance, '84px');
  assert(fullscreen.left >= 84 && fullscreen.left >= fullscreen.shellRight);
  assert.deepEqual(errors, []);
  console.log(
    'PASS: isolated create/cancel/delete without native dialogs; simulated macOS collapsed and fullscreen clearance.',
  );
} finally {
  await browser.close();
}
