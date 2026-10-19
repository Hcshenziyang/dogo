import { mkdir, readFile, writeFile, rm, rename, access } from 'node:fs/promises';
import { DatabaseSync, backup } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

/** One plugin writer per data directory; never restore a backup over newer remote receipts. */
export async function acquireData(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const lock = path.join(directory, '.dogo-host-lock');
  for (let attempt = 0; ; attempt++) {
    try { await mkdir(lock, { mode: 0o700 }); break; }
    catch (error) {
      if (error.code !== 'EEXIST' || attempt) throw error;
      const owner = JSON.parse(await readFile(path.join(lock, 'owner.json'), 'utf8'));
      if (!Number.isInteger(owner.pid) || owner.pid <= 0) throw new Error('插件锁损坏，请先核对旧进程');
      try { process.kill(owner.pid, 0); throw new Error('此数据目录已有 DogO 插件运行'); }
      catch (e) { if (e.code !== 'ESRCH') throw e; }
      const stale = lock + '.' + randomUUID() + '.stale';
      await rename(lock, stale); await rm(stale, { recursive: true });
    }
  }
  const nonce = randomUUID();
  await writeFile(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, nonce }), { mode: 0o600 });
  const release = async () => {
    const owner = JSON.parse(await readFile(path.join(lock, 'owner.json'), 'utf8'));
    if (owner.nonce === nonce) await rm(lock, { recursive: true });
  };
  try {
    const marker = path.join(directory, 'dogo-host-version.json');
    const version = await readFile(marker, 'utf8').then(JSON.parse, e => { if (e.code !== 'ENOENT') throw e; return null; });
    if (version && version.version !== 1) throw new Error('数据版本不兼容；未修改现有状态');
    if (!version) {
      const database = path.join(directory, 'desktop.sqlite');
      if (await access(database).then(() => true, () => false)) {
        const db = new DatabaseSync(database, { readOnly: true });
        try { await backup(db, path.join(directory, 'pre-plugin-' + Date.now() + '.sqlite')); } finally { db.close(); }
      }
      await writeFile(marker, JSON.stringify({ version: 1, storage: 'desktop.sqlite', formatChanged: false }), { flag: 'wx', mode: 0o600 });
    }
    return release;
  } catch (error) { await release(); throw error; }
}
