// Exercise canvas gestures and safety using only an isolated DSH and synthetic vault.
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
if (!home || !log || !packagePath || !isAbsolute(home)) throw Error('Expected isolated DSH home.');
const root = await realpath(home);
const safe = await Promise.all(['/tmp', tmpdir()].map((dir) => realpath(dir)));
if (!safe.some((dir) => root.startsWith(dir + sep))) throw Error('Expected a temporary home.');
const vault = join(root, 'Interaction Vault');
await mkdir(join(vault, 'notes'), { recursive: true });
await mkdir(join(vault, 'nested', 'notes'), { recursive: true });
await writeFile(join(vault, 'nested', 'notes', 'sample.md'), '# 错误的同名笔记');
await writeFile(
  join(vault, 'nested', 'collision.canvas'),
  JSON.stringify({
    nodes: [
      {
        id: 'collision',
        type: 'file',
        x: 0,
        y: 0,
        width: 250,
        height: 180,
        file: 'notes/sample.md',
      },
    ],
    edges: [],
  }),
);
await writeFile(join(vault, 'notes', 'sample.md'), '# 合成笔记\n\n![图](local.png)\n正文');
await writeFile(
  join(vault, 'notes', 'local.png'),
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
  ),
);
const path = join(vault, 'canvas.canvas');
const original = {
  nodes: [
    { id: 'group', type: 'group', x: -50, y: -50, width: 700, height: 250, label: '测试分组' },
    {
      id: 'a',
      type: 'text',
      x: 0,
      y: 0,
      width: 220,
      height: 140,
      text: '# 第一张',
      extra: { keep: true },
    },
    { id: 'b', type: 'text', x: 350, y: 0, width: 220, height: 140, text: '# 第二张' },
    { id: 'note', type: 'file', x: 0, y: 250, width: 250, height: 190, file: 'notes/sample.md' },
  ],
  edges: [
    {
      id: 'original',
      fromNode: 'a',
      fromSide: 'right',
      toNode: 'b',
      toSide: 'left',
      label: '原连线',
      customEdge: 1,
    },
  ],
  custom: { keep: true },
};
await writeFile(path, JSON.stringify(original, null, 2));
const url = (await readFile(log, 'utf8')).match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+/)?.[0];
if (!url) throw Error('Missing isolated DSH URL.');
const { chromium } = createRequire(import.meta.url)(packagePath);
const browser = await chromium.launch({
  headless: true,
  ...(process.env.EVAL_BROWSER_PATH ? { executablePath: process.env.EVAL_BROWSER_PATH } : {}),
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.setDefaultTimeout(12000);
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
const saved = async (predicate) => {
  for (let i = 0; i < 120; i++) {
    const value = JSON.parse(await readFile(path, 'utf8'));
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw Error('Expected canvas file change did not arrive');
};
const clickBlank = async () => {
  const r = await page.getByLabel('画布', { exact: true }).boundingBox();
  await page.mouse.click(r.x + 12, r.y + 12);
};
const drag = async (x1, y1, x2, y2, button = 'left') => {
  await page.mouse.move(x1, y1);
  await page.mouse.down({ button });
  await page.mouse.move(x2, y2, { steps: 8 });
  await page.mouse.up({ button });
};
const transform = () =>
  page.locator('.dw-canvas-plane').evaluate((el) => {
    const m = new DOMMatrix(getComputedStyle(el).transform);
    return { x: m.e, y: m.f, scale: m.a };
  });
try {
  await page.goto(url);
  const welcome = page.getByRole('button', { name: '继续', exact: true });
  try {
    await welcome.waitFor({ timeout: 3000 });
    await welcome.click();
  } catch {}
  await page.waitForTimeout(1000);
  const dialog = page.getByRole('dialog').first();
  if ((await dialog.count()) && (await dialog.getByRole('button', { name: '关闭' }).count()))
    await dialog.getByRole('button', { name: '关闭' }).click();
  await page.getByText('知识工作区', { exact: true }).first().click();
  await page.waitForTimeout(1200);
  let picker = page.getByLabel('选择知识库');
  if (!(await picker.count())) {
    await page.getByTitle('切换知识库').click();
    picker = page.getByLabel('选择知识库');
  }
  await picker.getByLabel('知识库目录').fill(vault);
  await picker.getByRole('button', { name: '打开', exact: true }).click();
  await page.getByLabel('笔记正文').waitFor();
  const tree = page.locator('.dw-tree');
  const separator = page.getByRole('separator', { name: '调整目录宽度' });
  const beforeWidth = (await tree.boundingBox()).width;
  let r = await separator.boundingBox();
  await drag(r.x + r.width / 2, r.y + 100, r.x + r.width / 2 + 100, r.y + 100);
  const wide = (await tree.boundingBox()).width;
  assert(wide > beforeWidth + 80, 'sidebar should widen');
  assert(await page.getByRole('button', { name: '展开 AI' }).isVisible());
  const mainWide = (await page.locator('.dw-main').boundingBox()).width;
  await page.getByRole('button', { name: '展开 AI' }).click();
  assert(await page.getByRole('button', { name: '收起 AI' }).isVisible());
  assert((await page.locator('.dw-main').boundingBox()).width < mainWide - 100);
  await page.getByRole('button', { name: '收起 AI' }).click();
  await page.getByRole('button', { name: 'canvas.canvas' }).click();
  const surface = page.getByLabel('画布', { exact: true });
  await surface.waitFor();
  await page.getByLabel('画布笔记预览').getByText('合成笔记').waitFor();
  await page.waitForFunction(
    () => document.querySelector('.dw-canvas-note-preview img')?.naturalWidth === 1,
  );
  // Double-click empty space creates and focuses a card at the pointer; double-clicking a card only edits it.
  let initialSurface = await surface.boundingBox();
  const createX = initialSurface.x + 15,
    createY = initialSurface.y + 70;
  const pointBefore = await transform();
  const worldX = (createX - initialSurface.x - pointBefore.x) / pointBefore.scale;
  const worldY = (createY - initialSurface.y - pointBefore.y) / pointBefore.scale;
  await page.mouse.dblclick(createX, createY);
  let created = await saved((value) => value.nodes.length === 5);
  const newNode = created.nodes.find(
    (item) => !original.nodes.some((before) => before.id === item.id),
  );
  assert.equal(newNode.type, 'text');
  assert.equal(newNode.text, '');
  assert(Math.abs(newNode.x + 110 - worldX) < 2);
  assert(Math.abs(newNode.y + 65 - worldY) < 2);
  assert(
    await page
      .locator(`[data-node-id="${newNode.id}"]`)
      .getByLabel('画布卡片文字')
      .evaluate((el) => el === document.activeElement),
  );
  await page.getByLabel('画布卡片文字').press('Escape');
  await surface.focus();
  await page.keyboard.press('Delete');
  await saved((value) => value.nodes.length === 4);
  const a = page.locator('[data-node-id="a"]');
  const b = page.locator('[data-node-id="b"]');
  let ab = await a.boundingBox();
  let bb = await b.boundingBox();
  await a.locator('.dw-canvas-markdown').click();
  assert((await a.getAttribute('class')).includes('selected'));
  const scale = (await transform()).scale;
  const edgeBefore = await page.locator('.dw-edge-hit').first().getAttribute('d');
  await page.mouse.move(ab.x + 35, ab.y + 65);
  await page.mouse.down();
  await page.mouse.move(ab.x + 75, ab.y + 85, { steps: 5 });
  assert.notEqual(
    await page.locator('.dw-edge-hit').first().getAttribute('d'),
    edgeBefore,
    'edge tracks live drag',
  );
  await page.mouse.up();
  let data = await saved((v) => v.nodes.find((n) => n.id === 'a').x !== 0);
  assert(Math.abs(data.nodes.find((n) => n.id === 'a').x - Math.round(40 / scale)) <= 2);
  assert.deepEqual(data.nodes.find((n) => n.id === 'a').extra, { keep: true });
  await page.keyboard.down('Shift');
  await b.locator('.dw-canvas-markdown').click();
  await page.keyboard.up('Shift');
  assert.equal(await page.locator('.dw-canvas-node.selected').count(), 2);
  const oldA = data.nodes.find((n) => n.id === 'a').x,
    oldB = data.nodes.find((n) => n.id === 'b').x;
  ab = await a.boundingBox();
  await drag(ab.x + 35, ab.y + 65, ab.x + 55, ab.y + 75);
  data = await saved((v) => v.nodes.find((n) => n.id === 'b').x !== oldB);
  assert.equal(
    data.nodes.find((n) => n.id === 'a').x - oldA,
    data.nodes.find((n) => n.id === 'b').x - oldB,
  );
  // Empty drag selects both cards without panning.
  await clickBlank();
  ab = await a.boundingBox();
  bb = await b.boundingBox();
  const oldView = await transform();
  await drag(ab.x - 15, ab.y - 15, bb.x + bb.width + 15, bb.y + bb.height + 15);
  assert.equal(await page.locator('.dw-canvas-node.selected').count(), 2);
  assert.deepEqual(await transform(), oldView);
  // Space and middle drag pan, with cancellation restoring the start.
  let sr = await surface.boundingBox();
  await surface.focus();
  await page.keyboard.down('Space');
  await drag(sr.x + 20, sr.y + 30, sr.x + 80, sr.y + 60);
  await page.keyboard.up('Space');
  let v = await transform();
  assert(Math.abs(v.x - oldView.x - 60) < 2);
  await drag(sr.x + 20, sr.y + 30, sr.x + 45, sr.y + 40, 'middle');
  let next = await transform();
  assert(Math.abs(next.x - v.x - 25) < 2);
  v = next;
  await surface.focus();
  await page.keyboard.down('Space');
  await page.mouse.move(sr.x + 20, sr.y + 30);
  await page.mouse.down();
  await page.mouse.move(sr.x + 80, sr.y + 60);
  await page.evaluate(() =>
    window.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 1, bubbles: true })),
  );
  await page.mouse.up();
  await page.keyboard.up('Space');
  assert.deepEqual(await transform(), v);
  // Zoom remains anchored at the pointer.
  const mx = sr.x + sr.width / 2,
    my = sr.y + sr.height / 2;
  const wx = (mx - sr.x - v.x) / v.scale,
    wy = (my - sr.y - v.y) / v.scale;
  await page.mouse.move(mx, my);
  await page.keyboard.down('Space');
  await page.mouse.wheel(0, -160);
  await page.keyboard.up('Space');
  await page.waitForTimeout(100);
  next = await transform();
  assert(next.scale > v.scale);
  assert(Math.abs((mx - sr.x - next.x) / next.scale - wx) < 1);
  assert(Math.abs((my - sr.y - next.y) / next.scale - wy) < 1);
  const beforeShiftWheel = await transform();
  await page.mouse.move(sr.x + 15, sr.y + 15);
  await page.keyboard.down('Shift');
  await page.mouse.wheel(0, 50);
  await page.keyboard.up('Shift');
  await page.waitForTimeout(100);
  const afterShiftWheel = await transform();
  assert(Math.abs(afterShiftWheel.x - beforeShiftWheel.x + 50) < 2);
  assert(Math.abs(afterShiftWheel.y - beforeShiftWheel.y) < 2);
  await page.keyboard.press('Shift+1');
  await page.waitForTimeout(100);
  await a.locator('.dw-canvas-markdown').dblclick();
  assert.equal(await page.locator('.dw-canvas-node').count(), 4);
  const editor = a.getByLabel('画布卡片文字');
  await editor.fill('输入 空格');
  await editor.press('Backspace');
  const beforeInputWheel = await transform();
  await editor.evaluate((el) =>
    el.dispatchEvent(
      new WheelEvent('wheel', { bubbles: true, cancelable: true, ctrlKey: true, deltaY: -120 }),
    ),
  );
  await editor.press('Space');
  await editor.evaluate((el) =>
    el.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -120 })),
  );
  assert.deepEqual(await transform(), beforeInputWheel);
  await editor.press('Backspace');
  assert.equal(await page.locator('.dw-canvas-node').count(), 4);
  await editor.press('Escape');
  assert.equal(await editor.count(), 0);
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
  await saved((value) => value.nodes.find((n) => n.id === 'a').text === '# 第一张');
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+z' : 'Control+Shift+z');
  data = await saved((value) => value.nodes.find((n) => n.id === 'a').text === '输入 空');
  // Top-left and edge handles resize while preserving the opposite side, and undo restores both.
  await a.locator('.dw-canvas-markdown').click();
  const beforeResize = { ...data.nodes.find((n) => n.id === 'a') };
  let handle = a.getByLabel('调整节点大小：左上');
  r = await handle.boundingBox();
  await drag(
    r.x + r.width / 2,
    r.y + r.height / 2,
    r.x + r.width / 2 - 25,
    r.y + r.height / 2 - 15,
  );
  data = await saved((value) => value.nodes.find((n) => n.id === 'a').x < beforeResize.x);
  let resized = data.nodes.find((n) => n.id === 'a');
  assert.equal(resized.x + resized.width, beforeResize.x + beforeResize.width);
  assert.equal(resized.y + resized.height, beforeResize.y + beforeResize.height);
  await surface.focus();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
  data = await saved((value) => value.nodes.find((n) => n.id === 'a').width === beforeResize.width);
  await a.locator('.dw-canvas-markdown').click();
  handle = a.getByLabel('调整节点大小：右', { exact: true });
  r = await handle.boundingBox();
  await drag(
    r.x + r.width / 2,
    r.y + r.height * 0.25,
    r.x + r.width / 2 + 20,
    r.y + r.height * 0.25,
  );
  data = await saved((value) => value.nodes.find((n) => n.id === 'a').width > beforeResize.width);
  resized = data.nodes.find((n) => n.id === 'a');
  assert.equal(resized.x, beforeResize.x);
  assert.equal(resized.height, beforeResize.height);
  await surface.focus();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
  await saved((value) => value.nodes.find((n) => n.id === 'a').width === beforeResize.width);
  // Create a connection by dragging its visible handle, then edit label and direction.
  await a.locator('.dw-canvas-markdown').click();
  const port = a.getByLabel('从节点右侧连线');
  r = await port.boundingBox();
  bb = await b.boundingBox();
  await drag(r.x + r.width / 2, r.y + r.height / 2, bb.x + 8, bb.y + bb.height / 2);
  data = await saved((value) => value.edges.length === 2);
  assert.equal(data.edges[1].fromNode, 'a');
  assert.equal(data.edges[1].toNode, 'b');
  const hit = page.locator('.dw-edge-hit').last();
  const midpoint = await hit.evaluate((el) => {
    const p = el.getPointAtLength(el.getTotalLength() / 2),
      m = el.getScreenCTM();
    return { x: p.x * m.a + p.y * m.c + m.e, y: p.x * m.b + p.y * m.d + m.f };
  });
  await page.mouse.click(midpoint.x, midpoint.y);
  await page.getByLabel('连线标签').fill('新标签');
  await page.getByLabel('连线箭头').selectOption('11');
  data = await saved(
    (value) => value.edges[1].label === '新标签' && value.edges[1].fromEnd === 'arrow',
  );
  assert.equal(data.edges[1].toEnd, 'arrow');
  assert.equal(data.edges[0].customEdge, 1);
  await surface.focus();
  await page.keyboard.press('Delete');
  await saved((value) => value.edges.length === 1);
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
  await saved((value) => value.edges.length === 2);
  // Tree-to-canvas creates a file reference and keeps the note intact.
  const noteFolder = page.getByRole('button', { name: '文件夹 notes' });
  if ((await noteFolder.getAttribute('aria-expanded')) !== 'true') await noteFolder.click();
  const noteEntry = page.getByRole('button', { name: 'notes/sample.md', exact: true });
  sr = await surface.boundingBox();
  await noteEntry.dragTo(surface, { targetPosition: { x: sr.width - 60, y: 80 } });
  data = await saved((value) => value.nodes.length === 5);
  assert.equal(data.nodes.filter((node) => node.file === 'notes/sample.md').length, 2);
  assert((await readFile(join(vault, 'notes', 'sample.md'), 'utf8')).includes('合成笔记'));
  // Switching documents preserves the viewport and resets the per-editor history.
  const oldTransform = await transform();
  const nested = page.getByRole('button', { name: '文件夹 nested', exact: true });
  if ((await nested.getAttribute('aria-expanded')) !== 'true') await nested.click();
  await page.getByRole('button', { name: 'nested/collision.canvas', exact: true }).click();
  await page
    .locator('[data-node-id=collision]')
    .getByLabel('画布笔记预览')
    .getByText('合成笔记')
    .waitFor();
  await page.locator('[data-node-id=collision]').getByRole('button', { name: '打开笔记' }).click();
  assert((await page.getByLabel('笔记正文').innerText()).includes('合成笔记'));
  assert(!(await page.getByLabel('笔记正文').innerText()).includes('错误的同名笔记'));
  await page.getByRole('button', { name: 'canvas.canvas' }).click();
  await surface.waitFor();
  assert.deepEqual(await transform(), oldTransform);
  assert(await page.getByRole('button', { name: '撤销', exact: true }).isDisabled());
  // A conflicting external write must survive failed local autosave, reload, and undo.
  await page.getByRole('button', { name: '添加文本' }).click();
  await saved((value) => value.nodes.length === 6);
  await page.waitForTimeout(1000);
  const external = JSON.parse(await readFile(path, 'utf8'));
  external.custom.external = 'new external revision';
  await writeFile(path, JSON.stringify(external, null, 2));
  await page.getByRole('button', { name: '添加文本' }).click();
  await page
    .getByRole('alert')
    .getByText(/文件已在其他位置修改/)
    .waitFor();
  assert.equal(JSON.parse(await readFile(path, 'utf8')).nodes.length, 6);
  await page.getByRole('button', { name: '重新加载', exact: true }).click();
  const reload = page.getByRole('dialog', { name: '重新加载？' });
  await reload.getByRole('button', { name: '重新加载', exact: true }).click();
  await reload.waitFor({ state: 'hidden' });
  assert(await page.getByRole('button', { name: '撤销', exact: true }).isDisabled());
  await surface.focus();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
  await page.waitForTimeout(900);
  data = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(data.custom.external, 'new external revision');
  assert.equal(data.nodes.length, 6);
  assert.deepEqual(data.custom.keep, true);
  // Preference survives reload and narrow viewport leaves space for the main panel.
  await page.reload();
  await page.getByText('知识工作区', { exact: true }).first().click();
  await page.getByLabel('笔记正文').waitFor();
  assert(Math.abs((await tree.boundingBox()).width - wide) < 2);
  assert(await page.getByRole('button', { name: '展开 AI' }).isVisible());
  await page.setViewportSize({ width: 1000, height: 800 });
  assert((await page.locator('.dw-main').boundingBox()).width >= 230);
  assert.deepEqual(errors, []);
  console.log(
    'PASS: sidebar width and AI persistence, note preview and relative image, canvas gestures, selection, history, links, tree drop, viewport restoration and external conflict safety.',
  );
} finally {
  await browser.close();
}
