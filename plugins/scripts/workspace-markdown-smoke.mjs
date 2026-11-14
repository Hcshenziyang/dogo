// Run against a disposable DSH home with the candidate plugin installed.
import assert from 'node:assert/strict';
import { readFile, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { isAbsolute, join, sep } from 'node:path';
import { tmpdir } from 'node:os';

const {
  EVAL_DSH_HOME: home,
  EVAL_DSH_LOG: log,
  EVAL_PLAYWRIGHT_PACKAGE: packagePath,
} = process.env;
if (!home || !log || !packagePath || !isAbsolute(home))
  throw Error('Expected isolated DSH home, log and Playwright.');
const root = await realpath(home);
const allowed = await Promise.all(['/tmp', tmpdir()].map((value) => realpath(value)));
if (!allowed.some((value) => root.startsWith(value + sep)))
  throw Error('Expected a temporary DSH home.');
const url = (await readFile(log, 'utf8')).match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+/)?.[0];
if (!url) throw Error('Missing isolated DSH URL.');
const { chromium } = createRequire(import.meta.url)(packagePath);
const browser = await chromium.launch({
  headless: true,
  ...(process.env.EVAL_BROWSER_PATH ? { executablePath: process.env.EVAL_BROWSER_PATH } : {}),
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.setDefaultTimeout(15000);
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
const dir = join(root, 'dogo', 'knowledge');
const waitFile = async (name, expected) => {
  await page.waitForFunction(
    async ({ name, expected }) => {
      const current = document.querySelector('[aria-label="笔记正文"]')?.textContent || '';
      return current.includes(expected);
    },
    { name, expected },
  );
  for (let n = 0; n < 100; n++) {
    const text = await readFile(join(dir, name + '.md'), 'utf8').catch(() => '');
    if (text.includes(expected)) return text;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw Error('Note was not saved: ' + name);
};
try {
  await page.goto(url);
  const welcome = page.getByRole('button', { name: '继续', exact: true });
  try {
    await welcome.waitFor({ timeout: 3000 });
    await welcome.click();
  } catch {}
  const dialog = page.getByRole('dialog').first();
  if ((await dialog.count()) && (await dialog.getByRole('button', { name: '关闭' }).count()))
    await dialog.getByRole('button', { name: '关闭' }).click();
  await page.waitForTimeout(1000);
  await page.getByText('知识工作区', { exact: true }).first().click();
  await page.getByLabel('笔记正文').waitFor();
  assert.equal(await realpath(await page.locator('.dw-tree-foot').getAttribute('title')), dir);
  async function create(name) {
    await page.getByRole('button', { name: '+ 笔记', exact: true }).click();
    const modal = page.getByRole('dialog', { name: '新建笔记' });
    await modal.getByLabel('新笔记名称').fill(name);
    await modal.getByLabel('新笔记名称').press('Enter');
    await modal.waitFor({ state: 'hidden' });
  }
  await create('目标笔记');
  let editor = page.getByLabel('笔记正文');
  await editor.fill('# 目标笔记\n\n## 章节\n\n目标内容');
  await waitFile('目标笔记', '目标内容');
  await create('编辑笔记');
  editor = page.getByLabel('笔记正文');
  await editor.fill('测试加粗');
  await editor.press(process.platform === 'darwin' ? 'Meta+a' : 'Control+a');
  await editor.press(process.platform === 'darwin' ? 'Meta+b' : 'Control+b');
  await waitFile('编辑笔记', '**测试加粗**');
  await editor.press(process.platform === 'darwin' ? 'Meta+b' : 'Control+b');
  await page.waitForTimeout(900);
  assert.equal(await readFile(join(dir, '编辑笔记.md'), 'utf8'), '测试加粗');
  await editor.fill(
    '# 编辑笔记\n\n[[目标笔记#章节|打开目标]] [外链](https://example.com)\n\n| 项目 | 数量 |\n| :--- | ---: |\n| **咖啡** | 2 |',
  );
  await waitFile('编辑笔记', '[[目标笔记#章节|打开目标]]');
  await page.locator('.dw-kicker').click();
  await page.locator('.dw-md-table strong').getByText('咖啡').waitFor();
  await page.getByLabel('表格第 2 行第 2 列').click();
  await page.getByLabel('编辑单元格').fill('3');
  await page.getByLabel('编辑单元格').press('Enter');
  const edited = await waitFile('编辑笔记', '| **咖啡** | 3 |');
  assert(edited.includes('| :--- | ---: |'));
  await page.getByLabel('表格第 2 行第 1 列').click({ button: 'right' });
  await page.getByRole('menuitem', { name: '在下方插入行' }).click();
  await waitFile('编辑笔记', '|  |  |');
  await page.getByLabel('表格第 3 行第 1 列').click();
  await page.getByLabel('编辑单元格').fill('空格可编辑');
  await page.getByLabel('编辑单元格').press('Tab');
  await page.getByLabel('编辑单元格').fill('第二格');
  await page.getByLabel('编辑单元格').press('Enter');
  await waitFile('编辑笔记', '| 空格可编辑 | 第二格 |');
  await page.getByLabel('表格第 2 行第 1 列').click({ button: 'right' });
  await page.getByRole('menuitem', { name: '在右侧插入列' }).click();
  await page.getByLabel('表格第 3 行第 2 列').waitFor();
  await page.getByLabel('表格第 3 行第 2 列').click();
  await page.getByLabel('编辑单元格').fill('新列');
  await page.getByLabel('编辑单元格').press('Enter');
  await waitFile('编辑笔记', '新列');
  await page.getByLabel('表格第 3 行第 2 列').click({ button: 'right' });
  await page.getByRole('menuitem', { name: '删除此列' }).click();
  await page.waitForTimeout(900);
  assert(!(await readFile(join(dir, '编辑笔记.md'), 'utf8')).includes('新列'));
  await editor.press(process.platform === 'darwin' ? 'Meta+e' : 'Control+e');
  await page.getByLabel('笔记阅读').waitFor();
  await page.evaluate(() => { window.open = (href) => { window.__openedLink = href; return null; }; });
  await page.getByLabel('笔记阅读').getByRole('link', { name: '外链' }).click();
  assert.equal(await page.evaluate(() => window.__openedLink), 'https://example.com');
  await page.getByLabel('笔记阅读').getByRole('link', { name: '打开目标' }).click();
  await page.getByLabel('笔记阅读').getByRole('heading', { name: '目标笔记' }).waitFor();
  await page.getByRole('button', { name: '返回笔记', exact: true }).click();
  await page.getByLabel('笔记阅读').getByRole('heading', { name: '编辑笔记' }).waitFor();
  await page.getByRole('button', { name: '编辑', exact: true }).click();
  editor = page.getByLabel('笔记正文');
  await editor.focus();
  await editor.press(process.platform === 'darwin' ? 'Meta+End' : 'Control+End');
  await editor.press('Enter');
  await editor.evaluate((element) => {
    const binary = atob(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    );
    const bytes = new Uint8Array(600000);
    bytes.set(Uint8Array.from(binary, (value) => value.charCodeAt(0)));
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], '图.png', { type: 'image/png' }));
    element.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }),
    );
  });
  const withImage = await waitFile('编辑笔记', '![图片](attachments/image-');
  const imagePath = withImage.match(/!\[图片\]\((attachments\/[^)]+)\)/)?.[1];
  assert(imagePath);
  const imageBytes = await readFile(join(dir, imagePath));
  assert.equal(imageBytes.length, 600000);
  assert.equal(imageBytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  await page.getByRole('button', { name: '阅读', exact: true }).click();
  const image = page.getByLabel('笔记阅读').locator('img[data-image-path]');
  await image.waitFor();
  await page.waitForFunction(() =>
    document
      .querySelector('.dw-reader img[data-image-path]')
      ?.getAttribute('src')
      ?.startsWith('blob:'),
  );
  await page.waitForFunction(() => document.querySelector('.dw-reader img[data-image-path]')?.naturalWidth > 0);
  if (process.env.EVAL_SCREENSHOT) await page.screenshot({ path: process.env.EVAL_SCREENSHOT });
  assert.deepEqual(errors, []);
  console.log(
    'PASS: isolated DSH editor shortcuts, read view, wiki navigation, editable tables and pasted images.',
  );
} finally {
  await browser.close();
}
