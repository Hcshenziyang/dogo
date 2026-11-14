// Run only against a disposable DSH home.
import assert from 'node:assert/strict';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { isAbsolute, join, sep } from 'node:path';
import { tmpdir } from 'node:os';

const {
  EVAL_DSH_HOME: home,
  EVAL_DSH_LOG: log,
  EVAL_PLAYWRIGHT_PACKAGE: packagePath,
} = process.env;
if (!home || !log || !packagePath || !isAbsolute(home))
  throw Error('Expected an isolated DSH home.');
const root = await realpath(home);
const safe = await Promise.all(['/tmp', tmpdir()].map((dir) => realpath(dir)));
if (!safe.some((dir) => root.startsWith(dir + sep))) throw Error('Expected a temporary DSH home.');
const first = join(root, 'Vault A'),
  second = join(root, 'Vault B');
await mkdir(join(first, 'folder'), { recursive: true });
await mkdir(second, { recursive: true });
await writeFile(join(first, 'same.md'), '# same\n原始内容');
await writeFile(join(second, 'same.md'), '# same\n原始内容');
await writeFile(join(first, 'folder', 'nested.md'), '# nested\n- [ ] 检查');
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
const read = async (dir) => readFile(join(dir, 'same.md'), 'utf8');
try {
  await page.goto(url);
  const welcome = page.getByRole('button', { name: '继续', exact: true });
  try {
    await welcome.waitFor({ timeout: 3000 });
    await welcome.click();
  } catch {}
  await page.waitForTimeout(1200);
  const dialog = page.getByRole('dialog').first();
  if ((await dialog.count()) && (await dialog.getByRole('button', { name: '关闭' }).count()))
    await dialog.getByRole('button', { name: '关闭' }).click();
  await page.getByText('知识工作区', { exact: true }).first().click();
  const picker = page.getByLabel('选择知识库');
  await picker.waitFor();
  await picker.getByLabel('知识库目录').fill(first);
  await picker.getByRole('button', { name: '打开', exact: true }).click();
  await page.getByLabel('笔记正文').waitFor();
  assert.equal(
    await realpath(await page.locator('.dw-tree-foot').getAttribute('title')),
    await realpath(first),
  );
  await page.getByRole('button', { name: 'folder/nested.md' }).click();
  assert((await page.getByLabel('笔记正文').innerText()).includes('nested'));
  await page.getByRole('button', { name: 'same', exact: true }).click();
  await page.waitForFunction(() =>
    document.querySelector('[aria-label="笔记正文"]')?.textContent?.includes('原始内容'),
  );
  await page.getByLabel('笔记正文').fill('# same\nA 的修改');
  await page.getByRole('button', { name: '切换' }).click();
  await picker.waitFor();
  assert((await read(first)).includes('A 的修改'));
  await picker.getByLabel('知识库目录').fill(second);
  await picker.getByRole('button', { name: '打开', exact: true }).click();
  await page.getByLabel('笔记正文').waitFor();
  assert((await page.getByLabel('笔记正文').innerText()).includes('原始内容'));
  await page.getByLabel('笔记正文').fill('# same\nB 的修改');
  await page.getByRole('button', { name: '切换' }).click();
  await picker.waitFor();
  assert((await read(second)).includes('B 的修改'));
  await picker.getByRole('button', { name: /Vault A/ }).click();
  await page.getByLabel('笔记正文').waitFor();
  await page.getByRole('button', { name: 'same', exact: true }).click();
  await page.waitForFunction(() =>
    document.querySelector('[aria-label="笔记正文"]')?.textContent?.includes('A 的修改'),
  );
  assert((await page.getByLabel('笔记正文').innerText()).includes('A 的修改'));
  await page.reload();
  await page.getByText('知识工作区', { exact: true }).first().click();
  await page.getByLabel('笔记正文').waitFor();
  assert.equal(
    await realpath(await page.locator('.dw-tree-foot').getAttribute('title')),
    await realpath(first),
  );
  assert.deepEqual(errors, []);
  console.log(
    'PASS: choose existing vault, nested notes, same-name isolation, flush on switch and restored selection.',
  );
} finally {
  await browser.close();
}
