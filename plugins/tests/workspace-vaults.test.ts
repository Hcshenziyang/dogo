import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Vaults } from '../workspace/vaults.js';

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'dogo-vaults-'));
  cleanup.push(root);
  const home = join(root, 'home'),
    a = join(root, 'Vault A'),
    b = join(root, 'Vault B');
  await mkdir(join(a, 'folder'), { recursive: true });
  await mkdir(b);
  await writeFile(join(a, 'same.md'), '# same\nA');
  await writeFile(join(b, 'same.md'), '# same\nB');
  await writeFile(join(a, 'folder', 'nested.md'), '# nested\n- [ ] task');
  return { root, home, a, b };
}

describe('knowledge vault selection', () => {
  it('opens existing nested notes and keeps sessions, proposals, and selected vault separate across restart', async () => {
    const { home, a, b } = await setup();
    const vaults = new Vaults(home);
    await vaults.initialize();
    expect(vaults.list().selected).toBeNull();
    const first = await vaults.openDirectory(a);
    const list = await vaults.control(first.id, 'list', {});
    expect(list.documents.map((d: any) => d.id)).toContain('folder/nested.md');
    const nested = await vaults.control(first.id, 'get', { id: 'folder/nested.md' });
    await vaults.control(first.id, 'bind-session', { id: 'vault-a-session' });
    await vaults.control(first.id, 'propose', {
      id: nested.id,
      revision: nested.revision,
      content: '# suggested',
      summary: 'test',
    });
    const second = await vaults.openDirectory(b);
    await vaults.control(second.id, 'bind-session', { id: 'vault-b-session' });
    expect((await vaults.control(second.id, 'status', {})).proposals).toEqual([]);
    expect((await vaults.control(first.id, 'get', { id: 'same.md' })).content).toContain('A');
    expect((await vaults.control(second.id, 'get', { id: 'same.md' })).content).toContain('B');
    expect(vaults.storeForSession('vault-a-session')?.directory).toBe(first.directory);
    const restarted = new Vaults(home);
    await restarted.initialize();
    expect(restarted.list().selected).toBe(second.id);
    expect(restarted.storeForSession('vault-a-session')?.directory).toBe(first.directory);
    expect((await restarted.control(first.id, 'status', {})).proposals).toHaveLength(1);
    expect((await restarted.select(first.id)).id).toBe(first.id);
    expect(await readFile(join(a, 'same.md'), 'utf8')).toBe('# same\nA');
    await expect(readFile(join(a, '.dogo', 'state.json'))).rejects.toThrow();
  });
  it('ignores symlinked and hidden content and rejects paths outside the chosen vault', async () => {
    const { root, home, a } = await setup();
    await mkdir(join(a, '.hidden'));
    await writeFile(join(a, '.hidden', 'secret.md'), 'secret');
    await symlink(root, join(a, 'link'));
    const vaults = new Vaults(home);
    await vaults.initialize();
    const vault = await vaults.openDirectory(a);
    const list = await vaults.control(vault.id, 'list', {});
    expect(list.documents.map((d: any) => d.id)).not.toContain('.hidden/secret.md');
    for (const id of ['../same.md', 'link/Vault A/same.md', '.hidden/secret.md'])
      await expect(vaults.control(vault.id, 'get', { id })).rejects.toThrow();
    await expect(vaults.openDirectory(join(root, 'absent'))).rejects.toThrow();
    expect(vaults.list().selected).toBe(vault.id);
  });
  it('reads images relative to a nested note and never escapes the vault', async () => {
    const { home, a } = await setup();
    const png = Buffer.from('89504e470d0a1a0a00000000', 'hex');
    await writeFile(join(a, 'root.png'), png);
    await writeFile(join(a, 'folder', 'local.png'), png);
    await mkdir(join(a, 'assets'));
    await writeFile(join(a, 'assets', 'embedded.png'), png);
    const vaults = new Vaults(home);
    await vaults.initialize();
    const vault = await vaults.openDirectory(a);
    for (const path of ['local.png', '../root.png', 'root.png', 'embedded.png']) {
      const result = await vaults.control(vault.id, 'image-read', {
        path,
        documentId: 'folder/nested.md',
      });
      expect(Buffer.from(result.data, 'base64')).toEqual(png);
    }
    await expect(
      vaults.control(vault.id, 'image-read', {
        path: '../../outside.png',
        documentId: 'folder/nested.md',
      }),
    ).rejects.toThrow();
  });
  it('keeps existing default metadata and creates a default vault only on request', async () => {
    const { home } = await setup();
    const vaults = new Vaults(home);
    await vaults.initialize();
    const vault = await vaults.openDirectory(vaults.defaultDirectory, true);
    expect(
      (await vaults.control(vault.id, 'list', {})).documents.some(
        (d: any) => d.id === '欢迎使用.md',
      ),
    ).toBe(true);
    await vaults.control(vault.id, 'bind-session', { id: 'legacy-session' });
    const restarted = new Vaults(home);
    await restarted.initialize();
    expect(restarted.storeForSession('legacy-session')?.directory).toBe(vault.directory);
  });

  it('discovers the original default vault before any registry exists', async () => {
    const { home } = await setup();
    const root = join(home, 'dogo', 'knowledge');
    await mkdir(join(root, '.dogo'), { recursive: true });
    await writeFile(join(root, 'old.md'), '# 原有笔记');
    await writeFile(
      join(root, '.dogo', 'state.json'),
      JSON.stringify({
        activeSession: 'old-session',
        sessions: ['old-session'],
        proposals: [],
      }),
    );
    const vaults = new Vaults(home);
    await vaults.initialize();
    expect(vaults.list().selected).toBeNull();
    expect(vaults.list().vaults).toHaveLength(1);
    expect(vaults.storeForSession('old-session')).toBeDefined();
    const selected = await vaults.select(vaults.list().vaults[0]!.id);
    expect((await vaults.control(selected.id, 'get', { id: 'old.md' })).content).toBe('# 原有笔记');
    expect((await vaults.control(selected.id, 'status', {})).activeSession).toBe('old-session');
  });
});
