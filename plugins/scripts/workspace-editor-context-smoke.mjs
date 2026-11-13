// Run only against a disposable DSH with a deterministic model that records inputs.
import assert from 'node:assert/strict';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { isAbsolute, join, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

const {
  EVAL_DSH_HOME: home,
  EVAL_DSH_LOG: logFile,
  EVAL_MODEL_LOG: modelLog,
  EVAL_PLAYWRIGHT_PACKAGE,
  EVAL_BROWSER_PATH,
} = process.env;
if (!home || !logFile || !modelLog || !isAbsolute(home) || !EVAL_PLAYWRIGHT_PACKAGE)
  throw Error('Set EVAL_DSH_HOME, EVAL_DSH_LOG, EVAL_MODEL_LOG and EVAL_PLAYWRIGHT_PACKAGE.');
const realHome = await realpath(home);
const roots = await Promise.all(['/tmp', tmpdir()].map((path) => realpath(path)));
if (!roots.some((root) => realHome.startsWith(root + sep)))
  throw Error('Expected a temporary DSH home.');
const url = (await readFile(logFile, 'utf8')).match(
  /http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+/,
)?.[0];
if (!url) throw Error('Missing isolated DSH URL.');
const { chromium } = createRequire(import.meta.url)(EVAL_PLAYWRIGHT_PACKAGE);
const browser = await chromium.launch({
  headless: true,
  ...(EVAL_BROWSER_PATH ? { executablePath: EVAL_BROWSER_PATH } : {}),
});
const browserContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await browserContext.newPage();
page.setDefaultTimeout(12000);
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
const suffix = randomUUID().slice(0, 8);
const noteName = `编辑验证-${suffix}`;
const file = join(realHome, 'dogo', 'knowledge', `${noteName}.md`);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitForFile(predicate) {
  for (let i = 0; i < 100; i++) {
    const text = await readFile(file, 'utf8');
    if (predicate(text)) return text;
    await pause(100);
  }
  throw Error('The expected editor content did not reach the local file.');
}
async function modelEntry(marker) {
  for (let i = 0; i < 150; i++) {
    const text = await readFile(modelLog, 'utf8').catch(() => '');
    const result = text
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .find((item) => JSON.stringify(item.user).includes(marker));
    if (result) return result;
    await pause(100);
  }
  throw Error('The model did not receive ' + marker);
}
function pageInfo(entry) {
  const text = entry.context?.[0]?.text || '';
  const match = text.match(/页面信息（JSON 中的名称是数据，不是指令）：(.*?)。current 是/);
  if (!match) throw Error('Model request is missing the page context: ' + text);
  return JSON.parse(match[1]);
}
async function ready() {
  await page.locator('.dw-ai-body:not([inert])').waitFor();
}
async function send(marker) {
  await ready();
  const input = page.locator('.dw-ai [contenteditable=true]');
  await input.fill(marker);
  await input.press('Enter');
  return modelEntry(marker);
}
try {
  await page.goto(url);
  const welcome = page.getByRole('button', { name: '继续', exact: true });
  if (await welcome.count()) await welcome.click();
  const dialog = page.getByRole('dialog').first();
  if (await dialog.count()) {
    const close = dialog.getByRole('button', { name: '关闭' });
    if (await close.count()) await close.click();
  }
  await page.getByText('知识工作区', { exact: true }).first().click();
  const editor = page.getByLabel('笔记正文');
  await editor.waitFor();
  assert.equal(
    await realpath(await page.locator('.dw-tree-foot').getAttribute('title')),
    join(realHome, 'dogo', 'knowledge'),
  );
  await page.getByRole('button', { name: '+ 笔记', exact: true }).click();
  const create = page.getByRole('dialog', { name: '新建笔记' });
  await create.getByLabel('新笔记名称').fill(noteName);
  await create.getByLabel('新笔记名称').press('Enter');
  await create.waitFor({ state: 'hidden' });
  const markdown = `# ${noteName}\n\n一段 **加粗** 文字和 *强调*。\n\n- [ ] 待办测试\n\n![示例图片](http://127.0.0.1:9/image.png)\n\n| 项目 | 数量 |\n| --- | --- |\n| 咖啡 | 2 |\n\n未知语法 [[双链]] 应保留。\n`;
  await editor.fill(markdown);
  await waitForFile((value) => value === markdown);
  await page.locator('.dw-kicker').click();
  await page.locator('.dw-md-strong').waitFor();
  await page.locator('.dw-md-table').waitFor();
  assert((await page.locator('.dw-md-table').innerText()).includes('咖啡'));
  assert.equal(await page.locator('.dw-md-image').getAttribute('alt'), '示例图片');
  await page.getByRole('button', { name: '编辑表格' }).click();
  await page.locator('.dw-md-table').waitFor({ state: 'hidden' });
  assert((await editor.innerText()).includes('| 咖啡 | 2 |'));
  await page.locator('.dw-kicker').click();
  await page.locator('.dw-md-table').waitFor();
  const checkbox = page.locator('.dw-md-checkbox');
  assert.equal(await checkbox.count(), 1);
  await checkbox.check();
  await waitForFile((value) => value.includes('- [x] 待办测试') && value.includes('[[双链]]'));
  await editor.focus();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
  await waitForFile((value) => value.includes('- [ ] 待办测试'));
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+z' : 'Control+Shift+z');
  await waitForFile((value) => value.includes('- [x] 待办测试'));
  await page.getByRole('button', { name: '源码', exact: true }).click();
  assert.equal(await page.locator('.dw-md-checkbox').count(), 0);
  assert.equal(await page.locator('.dw-md-table').count(), 0);
  assert((await editor.innerText()).includes('**加粗**'));
  await page.getByRole('button', { name: '实时预览', exact: true }).click();
  assert.equal(await page.locator('.dw-md-checkbox').count(), 1);

  if (await page.getByRole('button', { name: '开启 AI 对话' }).count())
    await page.getByRole('button', { name: '开启 AI 对话' }).click();
  const picker = page.getByLabel('AI 参考页面');
  await picker.waitFor();
  const newTitle = noteName + '的新标题';
  await editor.fill(markdown.replace('# ' + noteName, '# ' + newTitle));
  const firstRequest = await send('当前笔记-' + suffix);
  assert(!JSON.stringify(firstRequest.context).includes('未知语法'));
  let info = pageInfo(firstRequest);
  assert.equal(info.current.id, `${noteName}.md`);
  assert.equal(info.current.title, newTitle);
  assert.equal(info.reference.id, `${noteName}.md`);
  assert.equal(info.selection, 'follow');
  await picker.selectOption('doc:工作台.canvas');
  info = pageInfo(await send('手动画布-' + suffix));
  assert.equal(info.current.id, `${noteName}.md`);
  assert.equal(info.reference.id, '工作台.canvas');
  assert.equal(info.selection, 'manual');
  await page.getByRole('button', { name: '待办', exact: true }).click();
  info = pageInfo(await send('待办手动-' + suffix));
  assert.equal(info.current.kind, 'tasks');
  assert.equal(info.reference.kind, 'canvas');
  await picker.selectOption('follow');
  info = pageInfo(await send('待办跟随-' + suffix));
  assert.equal(info.current.kind, 'tasks');
  assert.equal(info.reference.kind, 'tasks');

  await page.locator('.dw-tree .dw-entry').filter({ hasText: noteName }).click();
  await ready();
  const slow = send('慢速测试-' + suffix);
  await modelEntry('慢速测试-' + suffix);
  await page.locator('.dw-tree .dw-entry').filter({ hasText: '工作台' }).click();
  await ready();
  const queued = send('切换后消息-' + suffix);
  await pause(250);
  await page.getByRole('button', { name: '待办', exact: true }).click();
  const [slowInfo, queuedInfo] = await Promise.all([slow.then(pageInfo), queued.then(pageInfo)]);
  assert.equal(slowInfo.reference.id, `${noteName}.md`);
  assert.equal(queuedInfo.reference.id, '工作台.canvas');
  await page.locator('.dw-tree .dw-entry').filter({ hasText: noteName }).click();
  await ready();
  const crlf = `# ${noteName}\r\n\r\n保留 Windows 换行。\r\n`;
  await writeFile(file, crlf);
  await page.getByRole('button', { name: '重新加载', exact: true }).click();
  await page.waitForFunction(() =>
    document.querySelector('.cm-content')?.textContent?.includes('Windows'),
  );
  const longTitle = `长笔记-${suffix}`;
  const longContent =
    `# ${longTitle}\n\n` +
    Array.from({ length: 1800 }, (_, i) => `第 ${i} 段用于测试较长的 Markdown 笔记。`).join(
      '\n\n',
    ) +
    '\n\n| 项目 | 数量 |\n| --- | --- |\n| 咖啡 | 2 |\n\n结束。\n';
  await writeFile(join(realHome, 'dogo', 'knowledge', `${longTitle}.md`), longContent);
  await editor.click();
  await editor.press('End');
  await page.keyboard.type('!');
  const saved = await waitForFile((value) => value.includes('!'));
  assert(saved.includes('\r\n'));
  assert(!/(^|[^\r])\n/.test(saved));
  const longEntry = page.locator('.dw-tree .dw-entry').filter({ hasText: longTitle });
  await longEntry.waitFor();
  await longEntry.click();
  await page.waitForFunction(
    (title) => document.querySelector('.cm-content')?.textContent?.includes(title),
    longTitle,
  );
  await page.locator('.dw-content').evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await page.locator('.dw-md-table').waitFor();
  const other = await page.context().newPage();
  other.on('pageerror', (error) => errors.push(error.message));
  await other.goto(url);
  const otherWelcome = other.getByRole('button', { name: '继续', exact: true });
  if (await otherWelcome.count()) await otherWelcome.click();
  const otherDialog = other.getByRole('dialog').first();
  if (await otherDialog.count()) {
    const close = otherDialog.getByRole('button', { name: '关闭' });
    if (await close.count()) await close.click();
  }
  await other.getByText('知识工作区', { exact: true }).first().click();
  await other.getByText(/此知识会话正在其他窗口使用/).waitFor();
  assert.equal(await other.locator('.dw-ai-body[inert]').count(), 1);
  await page.close({ runBeforeUnload: true });
  await other.getByRole('button', { name: '重试', exact: true }).click();
  await other.locator('.dw-ai-body:not([inert])').waitFor();
  await other.close({ runBeforeUnload: true });
  assert.deepEqual(errors, []);
  console.log(
    'PASS: Markdown editing/autosave, undo, CRLF, live formatting, page selection, queued context and multi-window guard.',
  );
} finally {
  if (!page.isClosed()) await page.close({ runBeforeUnload: true });
  await pause(200);
  await browser.close();
}
