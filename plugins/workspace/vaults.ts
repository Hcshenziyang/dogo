import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, realpath, rename, stat, unlink } from 'node:fs/promises';
import { basename, isAbsolute, join } from 'node:path';
import { WorkspaceStore } from './store.js';

type Vault = { id: string; directory: string; name: string; legacy: boolean };
type Registry = { version: 1; selected: string | null; vaults: Vault[] };

/** Persistent registry and separate stores keep notes, drafts and AI sessions scoped to a vault. */
export class Vaults {
  private registry: Registry = { version: 1, selected: null, vaults: [] };
  private stores = new Map<string, WorkspaceStore>();
  private tail: Promise<unknown> = Promise.resolve();
  private readonly registryPath: string;
  readonly defaultDirectory: string;
  constructor(readonly home: string) {
    this.registryPath = join(home, 'dogo', 'workspace-vaults-v1.json');
    this.defaultDirectory = join(home, 'dogo', 'knowledge');
  }
  private async serial<T>(fn: () => Promise<T>): Promise<T> {
    const work = this.tail.then(fn, fn);
    this.tail = work.catch(() => {});
    return work;
  }
  async initialize() {
    try {
      const data = JSON.parse(await readFile(this.registryPath, 'utf8'));
      if (
        data?.version !== 1 ||
        !Array.isArray(data.vaults) ||
        !(data.selected === null || typeof data.selected === 'string') ||
        !data.vaults.every(
          (v: Vault) =>
            typeof v.id === 'string' &&
            /^[a-f0-9]{64}$/.test(v.id) &&
            typeof v.directory === 'string' &&
            isAbsolute(v.directory) &&
            typeof v.name === 'string' &&
            typeof v.legacy === 'boolean',
        )
      )
        throw Error('知识库列表无效。');
      this.registry = data;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const legacy = await stat(this.defaultDirectory)
        .then((value) => value.isDirectory())
        .catch(() => false);
      if (legacy)
        this.registry.vaults = [this.makeVault(await realpath(this.defaultDirectory), true)];
    }
    for (const vault of this.registry.vaults) await this.load(vault);
  }
  private makeVault(directory: string, legacy: boolean): Vault {
    return {
      id: createHash('sha256').update(directory).digest('hex'),
      directory,
      name: basename(directory) || directory,
      legacy,
    };
  }
  private async load(vault: Vault): Promise<WorkspaceStore> {
    let store = this.stores.get(vault.id);
    if (!store) {
      store = new WorkspaceStore(
        vault.directory,
        vault.legacy
          ? {}
          : {
              createDefault: false,
              metadataDirectory: join(this.home, 'dogo', 'workspace-vault-state', vault.id),
            },
      );
      await store.initialize();
      this.stores.set(vault.id, store);
    }
    return store;
  }
  private async saveRegistry() {
    await mkdir(join(this.home, 'dogo'), { recursive: true, mode: 0o700 });
    const temp = this.registryPath + '.' + randomUUID() + '.tmp';
    const file = await open(temp, 'wx', 0o600);
    try {
      await file.writeFile(JSON.stringify(this.registry));
      await file.sync();
    } catch (error) {
      await unlink(temp).catch(() => {});
      throw error;
    } finally {
      await file.close();
    }
    try {
      await rename(temp, this.registryPath);
    } catch (error) {
      await unlink(temp).catch(() => {});
      throw error;
    }
  }
  list() {
    return {
      selected: this.registry.selected,
      vaults: this.registry.vaults,
      defaultDirectory: this.defaultDirectory,
    };
  }
  async openDirectory(value: unknown, useDefault = false) {
    return this.serial(async () => {
      if (typeof value !== 'string' || !isAbsolute(value) || value.includes('\0'))
        throw Error('请选择有效的绝对路径。');
      if (useDefault && value !== this.defaultDirectory) throw Error('默认目录无效。');
      if (useDefault) await new WorkspaceStore(value).initialize();
      const directory = await realpath(value);
      if (!(await stat(directory)).isDirectory()) throw Error('选择的位置不是文件夹。');
      const existing = this.registry.vaults.find((v) => v.directory === directory);
      const vault =
        existing || this.makeVault(directory, useDefault || directory === this.defaultDirectory);
      const store = await this.load(vault);
      // Verify readability before persisting the selection.
      await store.control('list');
      const previous = this.registry;
      this.registry = {
        version: 1,
        selected: vault.id,
        vaults: existing ? previous.vaults : [...previous.vaults, vault],
      };
      try {
        await this.saveRegistry();
      } catch (error) {
        this.registry = previous;
        throw error;
      }
      return vault;
    });
  }
  async select(id: unknown) {
    const vault = this.registry.vaults.find((v) => v.id === id);
    if (!vault) throw Error('未找到知识库。');
    return this.openDirectory(vault.directory);
  }
  async control(id: unknown, method: string, payload: any) {
    const vault = this.registry.vaults.find((v) => v.id === id);
    if (!vault) throw Error('请先选择知识库。');
    return (await this.load(vault)).control(method, payload);
  }
  storeForSession(id: unknown) {
    return [...this.stores.values()].find((store) => store.isManagedSession(id));
  }
}
