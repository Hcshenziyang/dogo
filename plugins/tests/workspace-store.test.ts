import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkspaceStore } from '../workspace/store.js';

const roots: string[] = [];
async function setup() {
  const tmp = await mkdtemp(join(tmpdir(), 'dogo-workspace-'));
  roots.push(tmp);
  const root = join(tmp, 'knowledge');
  const store = new WorkspaceStore(root);
  await store.initialize();
  return { store, root, tmp };
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('local knowledge workspace', () => {
  it('accepts canvas files with optional arrays while preserving extension fields', async () => {
    const { store, root } = await setup();
    await writeFile(
      join(root, 'legacy.canvas'),
      JSON.stringify({
        nodes: [
          {
            id: 'one',
            type: 'text',
            x: -3900,
            y: 13000,
            width: 300,
            height: 200,
            text: 'before',
            color: '5',
            styleAttributes: { textAlign: 'center' },
          },
        ],
        customMetadata: { retained: true },
      }),
    );
    const original = await store.control('get', { id: 'legacy.canvas' });
    const value = JSON.parse(original.content);
    value.nodes[0].text = 'after';
    const saved = await store.control('save', {
      id: original.id,
      revision: original.revision,
      content: JSON.stringify(value),
    });
    expect(JSON.parse(saved.content)).toEqual(value);
    expect(JSON.parse(saved.content).nodes[0].styleAttributes).toEqual({ textAlign: 'center' });
    expect(JSON.parse(saved.content).customMetadata).toEqual({ retained: true });
  });
  it('tracks the open and manually selected page only for a managed session', async () => {
    const { store } = await setup();
    const note = (await store.control('list')).documents.find((d: any) => d.kind === 'note');
    const canvas = (await store.control('list')).documents.find((d: any) => d.kind === 'canvas');
    await store.control('save', {
      id: note.id,
      revision: note.revision,
      content: '# 页面\n私有正文',
    });
    await store.control('bind-session', { id: 'knowledge-session' });
    const input = {
      sessionId: 'knowledge-session',
      owner: 'window-a',
      selection: 'follow',
      current: { kind: 'note', id: note.id },
    };
    const followed = await store.control('set-page-context', input);
    expect(followed.reference).toEqual(followed.current);
    expect(followed.current.id).toBe(note.id);
    expect(JSON.stringify(followed)).not.toContain('私有正文');
    const selected = await store.control('set-page-context', {
      ...input,
      selection: 'manual',
      current: { kind: 'tasks' },
      reference: { kind: 'canvas', id: canvas.id },
    });
    expect(selected.current).toEqual({ kind: 'tasks' });
    expect(selected.reference.id).toBe(canvas.id);
    expect(store.pageContext('knowledge-session')).toEqual(selected);
    await expect(
      store.control('set-page-context', { ...input, owner: 'window-b' }),
    ).rejects.toThrow('其他窗口');
    await expect(
      store.control('set-page-context', { ...input, sessionId: 'project' }),
    ).rejects.toThrow('会话无效');
    await expect(
      store.control('set-page-context', {
        ...input,
        current: { kind: 'note', id: '../outside.md' },
      }),
    ).rejects.toThrow();
    await store.control('clear-page-context', {
      sessionId: input.sessionId,
      owner: 'another-window',
    });
    expect(store.pageContext(input.sessionId)).toEqual(selected);
    await store.control('clear-page-context', { sessionId: input.sessionId, owner: input.owner });
    expect(store.pageContext(input.sessionId)).toBeUndefined();
  });
  it('persists editable Markdown and Canvas without login', async () => {
    const { store, root } = await setup();
    const note = await store.control('create', { title: '我的笔记' });
    expect(note.id).toBe('我的笔记.md');
    const saved = await store.control('save', {
      id: note.id,
      revision: note.revision,
      content: '# 我的笔记\n\n你好。\n',
    });
    expect(await readFile(join(root, note.id), 'utf8')).toContain('你好');
    const restarted = new WorkspaceStore(root);
    expect((await restarted.control('get', { id: note.id })).revision).toBe(saved.revision);
    expect((await restarted.control('list')).documents.some((d: any) => d.kind === 'canvas')).toBe(
      true,
    );
    const canvas = await restarted.control('create-canvas', { title: '新画布' });
    expect(JSON.parse(canvas.content)).toEqual({ nodes: [], edges: [] });
    await restarted.control('delete', { id: canvas.id, revision: canvas.revision });
    expect((await restarted.control('list')).documents.some((d: any) => d.id === canvas.id)).toBe(
      false,
    );
  });
  it('refuses stale writes and out-of-directory or symlink reads', async () => {
    const { store, root, tmp } = await setup();
    const note = await store.control('create', { title: '安全' });
    await store.control('save', { id: note.id, revision: note.revision, content: '# 新内容' });
    await expect(
      store.control('save', { id: note.id, revision: note.revision, content: '# 旧内容' }),
    ).rejects.toThrow('其他位置修改');
    await expect(store.control('get', { id: '../other.md' })).rejects.toThrow('文件名');
    await writeFile(join(tmp, 'outside.md'), 'private');
    await symlink(join(tmp, 'outside.md'), join(root, 'link.md'));
    await expect(store.control('get', { id: 'link.md' })).rejects.toThrow();
    expect((await store.control('list')).documents.some((d: any) => d.id === 'link.md')).toBe(
      false,
    );
  });
  it('links task checkboxes to the original note and checks the revision', async () => {
    const { store } = await setup();
    const note = await store.control('create', { title: '待办' });
    const saved = await store.control('save', {
      id: note.id,
      revision: note.revision,
      content: '# 待办\n\n- [ ] 提交文档\n',
    });
    const task = (await store.control('list')).tasks.find((t: any) => t.fileId === note.id);
    await store.control('toggle-task', {
      id: note.id,
      line: task.line,
      revision: saved.revision,
      done: true,
    });
    expect((await store.control('get', { id: note.id })).content).toContain('- [x] 提交文档');
    await expect(
      store.control('toggle-task', {
        id: note.id,
        line: task.line,
        revision: saved.revision,
        done: false,
      }),
    ).rejects.toThrow('已修改');
  });
  it('keeps AI proposals separate until explicit apply and refuses stale proposals', async () => {
    const { store } = await setup();
    const note = await store.control('create', { title: '正文' });
    const p = await store.control('propose', {
      id: note.id,
      revision: note.revision,
      content: '# 新建议\n',
      summary: '整理文字',
    });
    expect((await store.control('get', { id: note.id })).content).toBe(note.content);
    const second = new WorkspaceStore(store.directory);
    await second.initialize();
    expect((await second.control('proposal', { id: p.id })).proposal.content).toBe('# 新建议\n');
    await second.control('apply-proposal', { id: p.id });
    expect((await second.control('get', { id: note.id })).content).toBe('# 新建议\n');
    const fresh = await second.control('get', { id: note.id });
    const stale = await second.control('propose', {
      id: note.id,
      revision: fresh.revision,
      content: '# 不应覆盖',
      summary: '建议',
    });
    await second.control('save', {
      id: note.id,
      revision: fresh.revision,
      content: '# 我自己写的',
    });
    await expect(second.control('apply-proposal', { id: stale.id })).rejects.toThrow(
      '其他位置修改',
    );
    expect((await second.control('get', { id: note.id })).content).toBe('# 我自己写的');
  });
  it('validates JSON Canvas proposals and retains the scoped session across restart', async () => {
    const { store } = await setup();
    const canvas = (await store.control('list')).documents.find((d: any) => d.kind === 'canvas');
    await expect(
      store.control('save', {
        id: canvas.id,
        revision: canvas.revision,
        content: '{"nodes":[],"edges":[{"id":"x","fromNode":"missing","toNode":"missing"}]}',
      }),
    ).rejects.toThrow('连线');
    await store.control('bind-session', { id: 'knowledge-session' });
    const restarted = new WorkspaceStore(store.directory);
    await restarted.initialize();
    expect(restarted.isManagedSession('knowledge-session')).toBe(true);
    expect(restarted.isManagedSession('another-project')).toBe(false);
  });
});

describe('workspace image attachments', () => {
  it('lists supported image files and reads literal paths without changing notes or tasks', async () => {
    const { store, root, tmp } = await setup();
    const png = Buffer.from('89504e470d0a1a0a00000000', 'hex');
    await mkdir(join(root, 'images'));
    await writeFile(join(root, 'images', '截图%20 1.PNG'), png);
    await writeFile(join(root, 'images', 'photo.jpg'), Buffer.from('ffd8ff00', 'hex'));
    await writeFile(join(root, 'images', 'other.svg'), '<svg/>');
    await writeFile(join(tmp, 'external.png'), png);
    await symlink(join(tmp, 'external.png'), join(root, 'images', 'link.png'));
    const list = await store.control('list');
    expect(list.images.map((image: any) => image.id).sort()).toEqual([
      'images/photo.jpg',
      'images/截图%20 1.PNG',
    ]);
    expect(list.documents.every((document: any) => document.kind !== 'image')).toBe(true);
    expect(list.tasks.length).toBeGreaterThan(0);
    const image = await store.control('image-read', {
      path: 'images/截图%20 1.PNG',
      literalPath: true,
    });
    expect(Buffer.from(image.data, 'base64')).toEqual(png);
    await expect(
      store.control('image-read', { path: 'images/link.png', literalPath: true }),
    ).rejects.toThrow();
    await expect(
      store.control('image-read', { path: '../external.png', literalPath: true }),
    ).rejects.toThrow();
  });
  it('sends the open image identity as page context without including image bytes', async () => {
    const { store, root } = await setup();
    await writeFile(join(root, '截图%20.png'), Buffer.from('89504e470d0a1a0a', 'hex'));
    await store.control('bind-session', { id: 'image-session' });
    const input = {
      sessionId: 'image-session',
      owner: 'image-window',
      selection: 'follow',
      current: { kind: 'image', id: '截图%20.png', title: '截图%20.png' },
    };
    const result = await store.control('set-page-context', input);
    expect(result.current).toEqual(input.current);
    expect(result.reference).toEqual(input.current);
    expect(JSON.stringify(result)).not.toContain('89504e47');
    await expect(
      store.control('set-page-context', {
        ...input,
        current: { kind: 'image', id: '../截图%20.png' },
      }),
    ).rejects.toThrow();
    await expect(
      store.control('set-page-context', {
        ...input,
        current: { kind: 'image', id: 'missing.png' },
      }),
    ).rejects.toThrow();
  });
  it('stores chunked images without overwriting and reads them after restart', async () => {
    const { store, root } = await setup();
    const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(530000, 42)]);
    async function upload() {
      const { id } = await store.control('image-upload-start', { type: 'image/png' });
      for (let i = 0; i < png.length; i += 512 * 1024)
        await store.control('image-upload-chunk', {
          id,
          data: png.subarray(i, i + 512 * 1024).toString('base64'),
        });
      return (await store.control('image-upload-finish', { id })).path;
    }
    const first = await upload(),
      second = await upload();
    expect(first).not.toBe(second);
    expect(await readFile(join(root, first))).toEqual(png);
    const restarted = new WorkspaceStore(root);
    const a = await restarted.control('image-read', { path: first });
    const b = await restarted.control('image-read', { path: first, offset: 512 * 1024 });
    expect(Buffer.concat([Buffer.from(a.data, 'base64'), Buffer.from(b.data, 'base64')])).toEqual(
      png,
    );
  });
  it('refuses traversal, symlinks, executable content and unsupported image formats', async () => {
    const { store, root, tmp } = await setup();
    await writeFile(join(tmp, 'outside.png'), Buffer.from('89504e470d0a1a0a', 'hex'));
    await symlink(tmp, join(root, 'outside'));
    for (const path of [
      '../outside.png',
      '%2e%2e/outside.png',
      '/outside.png',
      'outside/outside.png',
    ])
      await expect(store.control('image-read', { path })).rejects.toThrow();
    const { id } = await store.control('image-upload-start', { type: 'image/png' });
    await store.control('image-upload-chunk', {
      id,
      data: Buffer.from('<script>bad</script>').toString('base64'),
    });
    await expect(store.control('image-upload-finish', { id })).rejects.toThrow('格式');
    await expect(store.control('image-upload-start', { type: 'image/svg+xml' })).rejects.toThrow();
  });
});
