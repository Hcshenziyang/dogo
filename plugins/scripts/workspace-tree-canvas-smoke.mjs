// Exercise a disposable vault and a large synthetic JSON Canvas in an isolated DSH home.
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
const vault = join(root, 'Canvas Vault');
await mkdir(join(vault, '一级', '二级'), { recursive: true });
await mkdir(join(vault, '空目录'), { recursive: true });
await writeFile(join(vault, '一级', '二级', '笔记.md'), '# 嵌套笔记\n原文');
await writeFile(
  join(vault, 'image.png'),
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
  ),
);
const nodes = [
  {
    id: 'group',
    type: 'group',
    x: -3900,
    y: 600,
    width: 800,
    height: 600,
    label: '测试分组',
    color: '5',
    styleAttributes: { custom: 'keep-group' },
  },
  {
    id: 'first',
    type: 'text',
    x: -3800,
    y: 700,
    width: 240,
    height: 150,
    text: '# 待编辑',
    color: '4',
    styleAttributes: { textAlign: 'center' },
  },
  { id: 'file', type: 'file', x: -3450, y: 700, width: 180, height: 140, file: 'image.png' },
  {
    id: 'link',
    type: 'link',
    x: -3200,
    y: 700,
    width: 180,
    height: 120,
    url: 'https://example.com',
  },
];
for (let i = 0; i < 197; i++)
  nodes.push({
    id: `extra-${i}`,
    type: 'text',
    x: -2000 + (i % 8) * 900,
    y: 1800 + Math.floor(i / 8) * 470,
    width: 230,
    height: 120,
    text: `合成节点 ${i}`,
  });
const original = {
  nodes,
  edges: [
    {
      id: 'edge',
      fromNode: 'first',
      toNode: 'file',
      fromSide: 'right',
      toSide: 'left',
      color: '5',
      label: '测试连线',
      styleAttributes: { pathfindingMethod: 'direct' },
    },
  ],
  custom: { preserved: true },
};
const canvasPath = join(vault, '一级', '二级', '大画布.canvas');
await writeFile(canvasPath, JSON.stringify(original, null, 2));
const url = (await readFile(log, 'utf8')).match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+/)?.[0];
if (!url) throw Error('Missing isolated DSH URL.');
const { chromium } = createRequire(import.meta.url)(packagePath);
const browser = await chromium.launch({
  headless: true,
  ...(process.env.EVAL_BROWSER_PATH ? { executablePath: process.env.EVAL_BROWSER_PATH } : {}),
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.setDefaultTimeout(15000);
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
const saved = async (predicate) => {
  for (let i = 0; i < 100; i++) {
    const data = JSON.parse(await readFile(canvasPath, 'utf8'));
    if (predicate(data)) return data;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw Error('Canvas change was not saved.');
};
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
  await picker.getByLabel('知识库目录').fill(vault);
  await picker.getByRole('button', { name: '打开', exact: true }).click();
  await page.getByLabel('笔记正文').waitFor();
  const folder1 = page.getByRole('button', { name: '文件夹 一级', exact: true });
  const folder2 = page.getByRole('button', { name: '文件夹 一级/二级', exact: true });
  await folder1.waitFor();
  if ((await folder1.getAttribute('aria-expanded')) === 'true') await folder1.click();
  assert.equal(await folder2.count(), 0);
  await folder1.click();
  await folder2.waitFor();
  if ((await folder2.getAttribute('aria-expanded')) === 'false') await folder2.click();
  await page.getByRole('button', { name: '一级/二级/笔记.md' }).waitFor();
  await page.getByRole('button', { name: '文件夹 空目录' }).click();
  await page.getByRole('button', { name: '+ 文件夹' }).click();
  let modal = page.getByRole('dialog', { name: '新建文件夹' });
  await modal.getByLabel('新文件夹名称').fill('子文件夹');
  await modal.getByLabel('新文件夹名称').press('Enter');
  await modal.waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: '+ 笔记' }).click();
  modal = page.getByRole('dialog', { name: '新建笔记' });
  await modal.getByLabel('新笔记名称').fill('新建笔记');
  await modal.getByLabel('新笔记名称').press('Enter');
  await modal.waitFor({ state: 'hidden' });
  assert(
    (await readFile(join(vault, '空目录', '子文件夹', '新建笔记.md'), 'utf8')).includes('新建笔记'),
  );
  await page.getByRole('button', { name: '一级/二级/大画布.canvas' }).click();
  const surface = page.getByLabel('画布', { exact: true });
  await surface.waitFor();
  const centerNode = async (node) => {
    const card = await node.boundingBox();
    const viewport = await surface.boundingBox();
    await page.mouse.move(viewport.x + viewport.width / 2, viewport.y + viewport.height / 2);
    await page.mouse.wheel(
      card.x + card.width / 2 - (viewport.x + viewport.width / 2),
      card.y + card.height / 2 - (viewport.y + viewport.height / 2),
    );
    await page.waitForTimeout(100);
  };
  assert.equal(await page.locator('.dw-canvas-node').count(), 201);
  const fitScale = parseInt(
    (await page.locator('.dw-canvas-scale').innerText()).replace('%', ''),
    10,
  );
  assert(fitScale >= 2 && fitScale <= 10, 'large canvas should fit the viewport');
  const firstNode = page.locator('[data-node-id="first"]');
  let box = await firstNode.boundingBox();
  assert(box && box.x >= 0 && box.y >= 0, 'negative-position node should be visible when fitted');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.keyboard.down(process.platform === 'darwin' ? 'Meta' : 'Control');
  await page.mouse.wheel(0, -1500);
  await page.keyboard.up(process.platform === 'darwin' ? 'Meta' : 'Control');
  await page.waitForTimeout(200);
  assert(parseInt(await page.locator('.dw-canvas-scale').innerText(), 10) > fitScale);
  await firstNode.locator('.dw-canvas-markdown').dblclick();
  const editor = firstNode.getByLabel('画布卡片文字');
  await editor.fill('# 修改后');
  await page.getByRole('button', { name: '适合画布' }).click();
  let data = await saved((item) => item.nodes.find((n) => n.id === 'first')?.text === '# 修改后');
  assert.deepEqual(data.nodes.find((n) => n.id === 'first').styleAttributes, {
    textAlign: 'center',
  });
  assert.deepEqual(data.edges[0].styleAttributes, { pathfindingMethod: 'direct' });
  assert.deepEqual(data.custom, { preserved: true });
  assert.equal(data.nodes.find((n) => n.id === 'first').x, -3800);
  assert.equal(data.edges[0].fromSide, 'right');
  // Zoom again around the card and drag its header across negative coordinates.
  box = await firstNode.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.keyboard.down(process.platform === 'darwin' ? 'Meta' : 'Control');
  await page.mouse.wheel(0, -1500);
  await page.keyboard.up(process.platform === 'darwin' ? 'Meta' : 'Control');
  await page.waitForTimeout(200);
  await centerNode(firstNode);
  const cardBody = firstNode.locator('.dw-canvas-markdown');
  box = await cardBody.boundingBox();
  await page.mouse.move(box.x + 15, box.y + 10);
  await page.mouse.down();
  await page.mouse.move(box.x + 70, box.y + 30, { steps: 5 });
  await page.mouse.up();
  data = await saved((item) => item.nodes.find((n) => n.id === 'first')?.x !== -3800);
  assert(data.nodes.find((n) => n.id === 'first').x < 0, 'drag must preserve negative coordinates');
  assert.equal(data.nodes.find((n) => n.id === 'file').file, 'image.png');
  assert.equal(data.edges[0].label, '测试连线');

  // A group moves its contents, and labels and image-backed file nodes remain editable.
  const image = page.locator('[data-node-id="file"] img');
  await image.waitFor();
  assert.equal(await image.evaluate((img) => img.naturalWidth), 1);
  for (let i = 0; i < 4; i++) await page.getByRole('button', { name: '缩小', exact: true }).click();
  const group = page.locator('[data-node-id="group"]');
  await centerNode(group);
  await group.getByLabel('分组名称').fill('修改分组');
  data = await saved((item) => item.nodes.find((n) => n.id === 'group')?.label === '修改分组');
  const before = new Map(data.nodes.map((node) => [node.id, { x: node.x, y: node.y }]));
  box = await group.locator('.dw-canvas-node-head').boundingBox();
  await page.mouse.move(box.x + 10, box.y + 5);
  await page.mouse.down();
  await page.mouse.move(box.x + 50, box.y + 25, { steps: 5 });
  await page.mouse.up();
  data = await saved(
    (item) => item.nodes.find((n) => n.id === 'group')?.x !== before.get('group').x,
  );
  const deltaX = data.nodes.find((n) => n.id === 'group').x - before.get('group').x;
  for (const id of ['first', 'file'])
    assert.equal(data.nodes.find((n) => n.id === id).x - before.get(id).x, deltaX);
  assert.deepEqual(data.nodes.find((n) => n.id === 'group').styleAttributes, {
    custom: 'keep-group',
  });
  const fileNode = page.locator('[data-node-id="file"]');
  await centerNode(fileNode);
  await fileNode.getByLabel('画布文件路径').fill('./image.png');
  await saved((item) => item.nodes.find((n) => n.id === 'file')?.file === './image.png');
  await fileNode.getByLabel('画布文件路径').fill('image.png');
  await saved((item) => item.nodes.find((n) => n.id === 'file')?.file === 'image.png');
  const linkNode = page.locator('[data-node-id="link"]');
  await centerNode(linkNode);
  await linkNode.getByLabel('画布链接地址').fill('https://example.org');
  await saved((item) => item.nodes.find((n) => n.id === 'link')?.url === 'https://example.org');

  // Resize, create a second connection and create/delete a node through the UI.
  await centerNode(firstNode);
  await firstNode.locator('.dw-canvas-markdown').click();
  const resize = firstNode.getByLabel('调整节点大小', { exact: true });
  box = await resize.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 8, box.y + box.height / 2 + 8, { steps: 5 });
  await page.mouse.up();
  data = await saved((item) => item.nodes.find((n) => n.id === 'first')?.width > 240);
  await page.getByRole('button', { name: '连线', exact: true }).click();
  await firstNode.locator('.dw-canvas-markdown').click();
  await centerNode(fileNode);
  await fileNode.locator('.dw-canvas-image').click();
  data = await saved((item) => item.edges.length === 2);
  assert.equal(data.edges[1].fromNode, 'first');
  assert.equal(data.edges[1].toNode, 'file');
  await page.getByRole('button', { name: '添加文本' }).click();
  data = await saved((item) => item.nodes.length === 202);
  const created = data.nodes.find((n) => !nodes.some((originalNode) => originalNode.id === n.id));
  assert.equal(created.type, 'text');
  await page.getByRole('button', { name: '删除选中项' }).click();
  await page
    .getByRole('dialog', { name: '删除画布内容' })
    .getByRole('button', { name: '删除', exact: true })
    .click();
  data = await saved((item) => item.nodes.length === 201);
  assert(!data.nodes.some((n) => n.id === created.id));
  assert.equal(data.edges.length, 2);
  await centerNode(group);
  await page.locator('.dw-edge-hit').last().click();
  assert(await page.getByRole('button', { name: '删除选中项' }).isEnabled());
  await page.getByRole('button', { name: '删除选中项' }).click();
  assert(
    (await page.getByRole('dialog', { name: '删除画布内容' }).innerText()).includes('删除所选连线'),
  );
  await page
    .getByRole('dialog', { name: '删除画布内容' })
    .getByRole('button', { name: '删除', exact: true })
    .click();
  data = await saved((item) => item.edges.length === 1);
  assert.equal(data.edges[0].id, 'edge');
  await page.reload();
  await page.getByText('知识工作区', { exact: true }).first().click();
  await page.getByLabel('笔记正文').waitFor();
  assert.deepEqual(errors, []);
  console.log(
    'PASS: folder hierarchy and creation; large canvas fit, pan, zoom, text, image, file, link, group move, resize, connect, add/delete, preservation and restart.',
  );
} finally {
  await browser.close();
}
