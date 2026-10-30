import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export class Store {
  constructor(readonly directory: string) {}
  async read<T>(name: string, fallback: T): Promise<T> {
    try {
      return JSON.parse(await readFile(join(this.directory, name + '.json'), 'utf8'));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return fallback;
      throw e;
    }
  }
  async write(name: string, value: unknown): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const path = join(this.directory, name + '.json');
    const temporary = path + '.' + randomUUID();
    const file = await open(temporary, 'wx', 0o600);
    try {
      await file.writeFile(JSON.stringify(value));
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path);
    const directory = await open(this.directory, 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }
  async lock(): Promise<() => Promise<void>> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const path = join(this.directory, 'runtime.lock');
    const tryLock = async () => {
      const file = await open(path, 'wx', 0o600);
      await file.writeFile(String(process.pid));
      await file.close();
      return async () => {
        await unlink(path).catch(() => {});
      };
    };
    try {
      return await tryLock();
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      const pid = Number(await readFile(path, 'utf8'));
      if (!Number.isSafeInteger(pid) || pid <= 0)
        throw Error('DogO 状态锁无效，请检查独立 DSH_HOME。');
      try {
        process.kill(pid, 0);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ESRCH') {
          await unlink(path);
          return tryLock();
        }
      }
      throw Error('另一个 DSH 进程正在使用此 DogO 身份；请为不同进程使用独立 DSH_HOME。');
    }
  }
}
