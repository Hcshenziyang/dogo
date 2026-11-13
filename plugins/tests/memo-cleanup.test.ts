import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearLegacyMemoDrafts } from '../devices/cleanup.js';
import { clearLegacyMemoFiles, finishLegacyMemoCleanup } from '../devices/cleanup-files.js';

describe('legacy memo draft cleanup', () => {
  it('removes memo drafts without touching knowledge drafts or account preferences', () => {
    const values = new Map([
      ['dogo.editor.local/unowned.new', 'memo draft'],
      ['dogo.memo.selection.local/unowned', 'memo selection'],
      ['dogo.draft.old-account.', 'old draft'],
      ['dogo.workspace.draft.v1:notes.md', 'knowledge draft'],
      ['dogo.login.preferences', 'device settings'],
    ]);
    const storage = {
      get length() { return values.size; },
      key: (index: number) => [...values.keys()][index] ?? null,
      removeItem: (key: string) => { values.delete(key); },
    } as Storage;
    expect(clearLegacyMemoDrafts(storage)).toBe(3);
    expect([...values.keys()]).toEqual(['dogo.workspace.draft.v1:notes.md', 'dogo.login.preferences']);
    expect(clearLegacyMemoDrafts(storage)).toBe(0);
  });
  it('removes memo files and dispatch metadata without touching accounts, device settings or knowledge', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dogo-memo-cleanup-'));
    const hash = 'a'.repeat(64);
    try {
      for (const name of ['local-memos-v1.json', `pending-${hash}.json`, `delivery-${hash}.json`, 'identities.json', 'consumer.json'])
        await writeFile(join(root, name), name);
      expect(await clearLegacyMemoFiles(root)).toEqual({ requested: false, removed: 0 });
      expect((await readdir(root)).length).toBe(5);
      await writeFile(join(root, 'memo-cleanup-request-v1.json'), JSON.stringify({version: 1, action: 'delete-memo-data'}));
      expect(await clearLegacyMemoFiles(root)).toEqual({ requested: true, removed: 3 });
      expect((await readdir(root)).sort()).toEqual(['consumer.json', 'identities.json', 'memo-cleanup-request-v1.json']);
      expect(await readFile(join(root, 'consumer.json'), 'utf8')).toBe('consumer.json');
      await finishLegacyMemoCleanup(root);
      expect(await clearLegacyMemoFiles(root)).toEqual({ requested: false, removed: 0 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
