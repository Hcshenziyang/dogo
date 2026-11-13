import { readFile, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';

const marker = 'memo-cleanup-request-v1.json';

/** Only this profile's explicit cleanup request permits deleting its old memo files. */
export async function clearLegacyMemoFiles(directory: string): Promise<{ requested: boolean; removed: number }> {
  let request: unknown;
  try {
    request = JSON.parse(await readFile(join(directory, marker), 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { requested: false, removed: 0 };
    throw error;
  }
  if (!request || typeof request !== 'object' || (request as any).action !== 'delete-memo-data' || (request as any).version !== 1)
    throw Error('备忘录清理请求无效，未删除数据。');
  const entries = await readdir(directory, { withFileTypes: true });
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (
      entry.name !== 'local-memos-v1.json' &&
      !/^(?:pending|memo-devices|delivery)-[a-f0-9]{64}\.json$/.test(entry.name)
    ) continue;
    await unlink(join(directory, entry.name));
    removed++;
  }
  return { requested: true, removed };
}

export async function finishLegacyMemoCleanup(directory: string): Promise<void> {
  try {
    await unlink(join(directory, marker));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}
