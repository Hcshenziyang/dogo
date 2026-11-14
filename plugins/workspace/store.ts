import { createHash, randomUUID, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, readdir, rename, stat, unlink } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';

const MAX_CONTENT = 1024 * 1024;
const MAX_IMAGE = 10 * 1024 * 1024;
const IMAGE_CHUNK = 512 * 1024;
const imageTypes: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

function imagePath(value: unknown): string[] {
  if (typeof value !== 'string' || value.length > 1024 || /[\\\0]/.test(value))
    throw Error('图片路径无效。');
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    throw Error('图片路径无效。');
  }
  const parts = decoded.split('/');
  if (
    parts.some(
      (part) =>
        !part || part === '.' || part === '..' || part.startsWith('.') || /[\\\0]/.test(part),
    )
  )
    throw Error('图片路径无效。');
  if (!imageTypes[extname(parts[parts.length - 1]!).toLowerCase()])
    throw Error('不支持此图片格式。');
  return parts;
}

function imageMatches(bytes: Buffer, type: string): boolean {
  if (type === 'image/png')
    return bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'));
  if (type === 'image/jpeg') return bytes.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex'));
  if (type === 'image/gif')
    return ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'));
  return (
    type === 'image/webp' &&
    bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
    bytes.subarray(8, 12).toString('ascii') === 'WEBP'
  );
}
const seedNote = `# 欢迎使用知识工作区\n\n这里是你的本地 Markdown 笔记。直接编辑内容，或在右侧与 AI 一起整理想法。\n\n## 试试看\n\n- [ ] 写下第一个想法\n- [ ] 打开画布，整理内容之间的关系\n\nAI 提出的修改需要你查看并应用。\n`;
const seedCanvas = {
  nodes: [
    { id: 'welcome', type: 'text', text: '知识工作区', x: 250, y: 60, width: 190, height: 90 },
    { id: 'notes', type: 'text', text: '笔记与想法', x: 70, y: 270, width: 190, height: 90 },
    { id: 'tasks', type: 'text', text: '待办与行动', x: 430, y: 270, width: 190, height: 90 },
  ],
  edges: [
    { id: 'edge-notes', fromNode: 'welcome', fromSide: 'bottom', toNode: 'notes', toSide: 'top' },
    { id: 'edge-tasks', fromNode: 'welcome', fromSide: 'bottom', toNode: 'tasks', toSide: 'top' },
  ],
};

export interface DocumentData {
  id: string;
  title: string;
  kind: 'note' | 'canvas';
  content: string;
  revision: string;
}
export interface Proposal {
  id: string;
  fileId: string;
  revision: string;
  content: string;
  summary: string;
  createdAt: string;
}
interface Metadata {
  activeSession: string | null;
  sessions: string[];
  proposals: Proposal[];
}
interface Task {
  id: string;
  fileId: string;
  title: string;
  line: number;
  text: string;
  done: boolean;
  revision: string;
}
export type WorkspacePage =
  | { kind: 'note' | 'canvas'; id: string; title: string }
  | { kind: 'tasks' | 'none' };
export interface WorkspacePageContext {
  current: WorkspacePage;
  reference: WorkspacePage;
  selection: 'follow' | 'manual';
}
const version = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

function fileId(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length > 220 ||
    value.length === 0 ||
    basename(value) !== value ||
    value.startsWith('.') ||
    /[\\/\0]/.test(value) ||
    !['.md', '.canvas'].includes(extname(value))
  ) {
    throw Error('无效的知识库文件名。');
  }
  return value;
}
function bounded(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > max)
    throw Error(label + '无效或过长。');
  return value;
}
function validateCanvas(content: string): void {
  let value: any;
  try {
    value = JSON.parse(content);
  } catch {
    throw Error('画布 JSON 格式不正确。');
  }
  if (
    !value ||
    typeof value !== 'object' ||
    !Array.isArray(value.nodes) ||
    !Array.isArray(value.edges)
  ) {
    throw Error('画布必须包含 nodes 和 edges 数组。');
  }
  const ids = new Set<string>();
  for (const n of value.nodes) {
    if (
      !n ||
      typeof n.id !== 'string' ||
      ids.has(n.id) ||
      typeof n.type !== 'string' ||
      ![n.x, n.y, n.width, n.height].every(Number.isFinite) ||
      n.width <= 0 ||
      n.height <= 0
    ) {
      throw Error('画布节点格式不正确或节点 ID 重复。');
    }
    ids.add(n.id);
  }
  const edgeIds = new Set<string>();
  for (const e of value.edges) {
    if (
      !e ||
      typeof e.id !== 'string' ||
      edgeIds.has(e.id) ||
      !ids.has(e.fromNode) ||
      !ids.has(e.toNode)
    ) {
      throw Error('画布连线格式不正确或引用了不存在的节点。');
    }
    edgeIds.add(e.id);
  }
}
function titleOf(id: string, content: string): string {
  if (id.endsWith('.canvas')) return id.slice(0, -7);
  return content.match(/^#\s+(.+)\s*$/m)?.[1]?.trim() || id.slice(0, -3);
}
function parseTasks(doc: DocumentData): Task[] {
  if (doc.kind !== 'note') return [];
  return doc.content.split('\n').flatMap((line, i) => {
    const match = line.match(/^\s*[-*+]\s+\[([ xX])\]\s+(.*)$/);
    return match
      ? [
          {
            id: doc.id + ':' + i,
            fileId: doc.id,
            title: doc.title,
            line: i,
            text: match[2] ?? '',
            done: match[1] !== ' ',
            revision: doc.revision,
          },
        ]
      : [];
  });
}

/** Owns only this plugin's flat Markdown/JSON Canvas directory, independently of old memos. */
export class WorkspaceStore {
  private metadata: Metadata = { activeSession: null, sessions: [], proposals: [] };
  private readonly pageContexts = new Map<string, { owner: string; value: WorkspacePageContext }>();
  private ready: Promise<void> | undefined;
  private tail: Promise<unknown> = Promise.resolve();
  private readonly imageUploads = new Map<
    string,
    { type: string; chunks: Buffer[]; size: number; updated: number }
  >();
  constructor(readonly directory: string) {}
  private async serial<T>(fn: () => Promise<T>): Promise<T> {
    const work = this.tail.then(fn, fn);
    this.tail = work.catch(() => {});
    return work;
  }
  async initialize(): Promise<void> {
    if (!this.ready)
      this.ready = this.initializeOnce().catch((e) => {
        this.ready = undefined;
        throw e;
      });
    return this.ready;
  }
  private async initializeOnce(): Promise<void> {
    let existed = true;
    try {
      await stat(this.directory);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      existed = false;
    }
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await mkdir(join(this.directory, '.dogo'), { recursive: true, mode: 0o700 });
    if (!existed) {
      await this.createIfAbsent('欢迎使用.md', seedNote);
      await this.createIfAbsent('工作台.canvas', JSON.stringify(seedCanvas, null, 2) + '\n');
    }
    try {
      const value = JSON.parse(await readFile(join(this.directory, '.dogo', 'state.json'), 'utf8'));
      if (
        !value ||
        !Array.isArray(value.sessions) ||
        !Array.isArray(value.proposals) ||
        !value.sessions.every((s: unknown) => typeof s === 'string') ||
        !(value.activeSession === null || typeof value.activeSession === 'string')
      )
        throw Error('知识工作区状态文件无效。');
      this.metadata = value;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      await this.saveMetadata();
    }
  }
  private async createIfAbsent(id: string, content: string): Promise<void> {
    try {
      const f = await open(join(this.directory, id), 'wx', 0o600);
      try {
        await f.writeFile(content);
        await f.sync();
      } finally {
        await f.close();
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
  }
  private async atomic(path: string, content: string): Promise<void> {
    const temp = path + '.' + randomBytes(8).toString('hex') + '.tmp';
    const f = await open(temp, 'wx', 0o600);
    try {
      await f.writeFile(content);
      await f.sync();
    } catch (e) {
      await unlink(temp).catch(() => {});
      throw e;
    } finally {
      await f.close();
    }
    try {
      await rename(temp, path);
    } catch (e) {
      await unlink(temp).catch(() => {});
      throw e;
    }
  }
  private async saveMetadata(next: Metadata = this.metadata): Promise<void> {
    await this.atomic(join(this.directory, '.dogo', 'state.json'), JSON.stringify(next));
    this.metadata = next;
  }
  private async readDocument(idValue: unknown): Promise<DocumentData> {
    const id = fileId(idValue);
    const f = await open(
      join(this.directory, id),
      constants.O_RDONLY | (constants.O_NOFOLLOW || 0),
    );
    let content: string;
    try {
      const st = await f.stat();
      if (!st.isFile() || st.size > MAX_CONTENT) throw Error('文件过大或不是普通文件。');
      content = await f.readFile('utf8');
    } finally {
      await f.close();
    }
    return {
      id,
      title: titleOf(id, content),
      kind: id.endsWith('.md') ? 'note' : 'canvas',
      content,
      revision: version(content),
    };
  }
  private async writeDocument(
    idValue: unknown,
    contentValue: unknown,
    expectedValue: unknown,
  ): Promise<DocumentData> {
    const id = fileId(idValue),
      content = bounded(contentValue, '内容', MAX_CONTENT);
    const expected = bounded(expectedValue, '文件版本', 128);
    if (id.endsWith('.canvas')) validateCanvas(content);
    const before = await this.readDocument(id);
    if (before.revision !== expected) throw Error('文件已在其他位置修改，请重新加载后再保存。');
    const path = join(this.directory, id),
      temp = path + '.' + randomUUID() + '.tmp';
    const f = await open(temp, 'wx', 0o600);
    try {
      await f.writeFile(content);
      await f.sync();
    } catch (e) {
      await unlink(temp).catch(() => {});
      throw e;
    } finally {
      await f.close();
    }
    try {
      if ((await this.readDocument(id)).revision !== expected)
        throw Error('文件已在其他位置修改，请重新加载后再保存。');
      await rename(temp, path);
    } catch (e) {
      await unlink(temp).catch(() => {});
      throw e;
    }
    return {
      id,
      title: titleOf(id, content),
      kind: before.kind,
      content,
      revision: version(content),
    };
  }
  private async listAll(): Promise<{ documents: Omit<DocumentData, 'content'>[]; tasks: Task[] }> {
    const entries = await readdir(this.directory, { withFileTypes: true });
    const docs: DocumentData[] = [];
    for (const entry of entries) {
      if (
        !entry.isFile() ||
        entry.name.startsWith('.') ||
        !['.md', '.canvas'].includes(extname(entry.name))
      )
        continue;
      docs.push(await this.readDocument(entry.name));
    }
    docs.sort((a, b) => a.title.localeCompare(b.title, 'zh-CN'));
    return {
      documents: docs.map(({ content: _content, ...doc }) => doc),
      tasks: docs.flatMap(parseTasks),
    };
  }
  private async imageFile(value: unknown): Promise<{ path: string; type: string }> {
    const parts = imagePath(value);
    let path = this.directory;
    for (const part of parts) {
      path = join(path, part);
      if ((await lstat(path)).isSymbolicLink()) throw Error('图片路径不能包含符号链接。');
    }
    return { path, type: imageTypes[extname(path).toLowerCase()]! };
  }
  isManagedSession(id: unknown): boolean {
    return typeof id === 'string' && this.metadata.sessions.includes(id);
  }
  pageContext(id: unknown): WorkspacePageContext | undefined {
    return typeof id === 'string' ? this.pageContexts.get(id)?.value : undefined;
  }
  private async page(value: any): Promise<WorkspacePage> {
    if (value?.kind === 'tasks' || value?.kind === 'none') return { kind: value.kind };
    if (value?.kind !== 'note' && value?.kind !== 'canvas') throw Error('页面类型无效。');
    const doc = await this.readDocument(value.id);
    if (doc.kind !== value.kind) throw Error('页面类型与文件不匹配。');
    const title = value.title === undefined ? doc.title : bounded(value.title, '页面标题', 400);
    if (/[\r\n\0]/.test(title)) throw Error('页面标题无效。');
    return { kind: doc.kind, id: doc.id, title };
  }
  async control(method: string, payload: any = {}): Promise<any> {
    await this.initialize();
    return this.serial(async () => {
      switch (method) {
        case 'image-read': {
          const { path, type } = await this.imageFile(payload.path);
          const f = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
          try {
            const info = await f.stat();
            if (!info.isFile() || info.size > MAX_IMAGE || info.size === 0)
              throw Error('图片过大或不是文件。');
            const offset = payload.offset ?? 0;
            if (!Number.isSafeInteger(offset) || offset < 0 || offset >= info.size)
              throw Error('图片读取位置无效。');
            const bytes = Buffer.alloc(Math.min(IMAGE_CHUNK, info.size - offset));
            const { bytesRead } = await f.read(bytes, 0, bytes.length, offset);
            if (!bytesRead) throw Error('图片读取失败。');
            if (offset === 0 && !imageMatches(bytes.subarray(0, bytesRead), type))
              throw Error('图片格式不匹配。');
            return { type, size: info.size, data: bytes.subarray(0, bytesRead).toString('base64') };
          } finally {
            await f.close();
          }
        }
        case 'image-upload-start': {
          for (const [id, upload] of this.imageUploads)
            if (Date.now() - upload.updated > 300000) this.imageUploads.delete(id);
          if (!Object.values(imageTypes).includes(payload.type) || this.imageUploads.size >= 10)
            throw Error('不支持此图片或上传任务过多。');
          const id = randomUUID();
          this.imageUploads.set(id, {
            type: payload.type,
            chunks: [],
            size: 0,
            updated: Date.now(),
          });
          return { id };
        }
        case 'image-upload-chunk': {
          const upload = this.imageUploads.get(payload.id);
          if (
            !upload ||
            typeof payload.data !== 'string' ||
            payload.data.length > Math.ceil(IMAGE_CHUNK / 3) * 4 + 4 ||
            !/^[A-Za-z0-9+/]*={0,2}$/.test(payload.data)
          )
            throw Error('图片上传数据无效。');
          const bytes = Buffer.from(payload.data, 'base64');
          if (
            !bytes.length ||
            bytes.length > IMAGE_CHUNK ||
            upload.size + bytes.length > MAX_IMAGE
          ) {
            this.imageUploads.delete(payload.id);
            throw Error('图片过大或上传数据无效。');
          }
          upload.chunks.push(bytes);
          upload.size += bytes.length;
          upload.updated = Date.now();
          return { size: upload.size };
        }
        case 'image-upload-cancel':
          this.imageUploads.delete(payload.id);
          return {};
        case 'image-upload-finish': {
          const upload = this.imageUploads.get(payload.id);
          this.imageUploads.delete(payload.id);
          if (!upload || !imageMatches(Buffer.concat(upload.chunks), upload.type))
            throw Error('图片格式无效。');
          const folder = join(this.directory, 'attachments');
          await mkdir(folder, { mode: 0o700 }).catch((e: NodeJS.ErrnoException) => {
            if (e.code !== 'EEXIST') throw e;
          });
          if (!(await lstat(folder)).isDirectory() || (await lstat(folder)).isSymbolicLink())
            throw Error('附件目录无效。');
          const extension = Object.entries(imageTypes).find(
            ([ext, type]) => type === upload.type && ext !== '.jpeg',
          )![0];
          const name = 'image-' + randomUUID() + extension;
          const f = await open(join(folder, name), 'wx', 0o600);
          try {
            await f.writeFile(Buffer.concat(upload.chunks));
            await f.sync();
          } catch (e) {
            await unlink(join(folder, name)).catch(() => {});
            throw e;
          } finally {
            await f.close();
          }
          return { path: 'attachments/' + name };
        }
        case 'status':
          return {
            directory: this.directory,
            activeSession: this.metadata.activeSession,
            proposals: this.metadata.proposals.map(({ content: _content, ...p }) => p),
          };
        case 'list':
          return this.listAll();
        case 'get':
          return this.readDocument(payload.id);
        case 'create':
        case 'create-canvas': {
          const title = bounded(payload.title, '标题', 200).trim();
          if (!title || /[\r\n]/.test(title)) throw Error('请输入单行笔记标题。');
          const clean =
            title
              .replace(/[\\/:*?"<>|\x00-\x1f]/g, '')
              .trim()
              .replace(/^\.+/, '')
              .slice(0, 80) || '新笔记';
          for (let n = 0; n < 1000; n++) {
            const isCanvas = method === 'create-canvas';
            const id = clean + (n ? ' ' + (n + 1) : '') + (isCanvas ? '.canvas' : '.md');
            try {
              const f = await open(join(this.directory, id), 'wx', 0o600);
              try {
                await f.writeFile(
                  isCanvas
                    ? JSON.stringify({ nodes: [], edges: [] }, null, 2) + '\n'
                    : '# ' + title + '\n\n',
                );
                await f.sync();
              } finally {
                await f.close();
              }
              return this.readDocument(id);
            } catch (e) {
              if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
            }
          }
          throw Error('同名笔记太多。');
        }
        case 'save':
          return this.writeDocument(payload.id, payload.content, payload.revision);
        case 'delete': {
          const doc = await this.readDocument(payload.id);
          if (doc.revision !== payload.revision) throw Error('文件已修改，未删除。请重新加载。');
          await unlink(join(this.directory, doc.id));
          return { id: doc.id };
        }
        case 'toggle-task': {
          const doc = await this.readDocument(payload.id);
          if (doc.revision !== payload.revision)
            throw Error('笔记已修改，未更新待办。请重新加载。');
          const lines = doc.content.split('\n'),
            i = payload.line;
          if (
            !Number.isSafeInteger(i) ||
            i < 0 ||
            i >= lines.length ||
            typeof payload.done !== 'boolean'
          )
            throw Error('待办位置无效。');
          const original = lines[i] ?? '';
          if (!/^\s*[-*+]\s+\[[ xX]\]\s+/.test(original)) throw Error('该行已不是待办。');
          lines[i] = original.replace(
            /^(\s*[-*+]\s+\[)[ xX](\])/,
            '$1' + (payload.done ? 'x' : ' ') + '$2',
          );
          return this.writeDocument(doc.id, lines.join('\n'), doc.revision);
        }
        case 'bind-session': {
          const id = bounded(payload.id, '会话 ID', 200);
          if (!id.trim() || /[\x00-\x1f]/.test(id)) throw Error('会话 ID 无效。');
          const sessions = this.metadata.sessions.includes(id)
            ? this.metadata.sessions
            : [...this.metadata.sessions, id];
          await this.saveMetadata({ ...this.metadata, sessions, activeSession: id });
          return { id };
        }
        case 'set-page-context': {
          if (!this.isManagedSession(payload.sessionId)) throw Error('知识工作区会话无效。');
          const owner = bounded(payload.owner, '窗口标识', 200);
          if (!owner || !['follow', 'manual'].includes(payload.selection))
            throw Error('页面上下文无效。');
          const existing = this.pageContexts.get(payload.sessionId);
          if (existing && existing.owner !== owner)
            throw Error('此知识会话正在其他窗口使用，请关闭原窗口后重试。');
          const current = await this.page(payload.current);
          const reference =
            payload.selection === 'follow' ? current : await this.page(payload.reference);
          const value: WorkspacePageContext = { current, reference, selection: payload.selection };
          this.pageContexts.set(payload.sessionId, { owner, value });
          return value;
        }
        case 'clear-page-context': {
          const current = this.pageContexts.get(payload.sessionId);
          if (current?.owner === payload.owner) this.pageContexts.delete(payload.sessionId);
          return { cleared: true };
        }
        case 'propose': {
          const doc = await this.readDocument(payload.id);
          const content = bounded(payload.content, '建议内容', MAX_CONTENT);
          const summary = bounded(payload.summary, '建议说明', 500).trim();
          if (doc.revision !== payload.revision) throw Error('笔记已变化，请重新读取后提出建议。');
          if (doc.kind === 'canvas') validateCanvas(content);
          if (content === doc.content) throw Error('建议内容与原内容相同。');
          if (this.metadata.proposals.length >= 50)
            throw Error('待处理建议过多，请先处理已有建议。');
          const p: Proposal = {
            id: randomUUID(),
            fileId: doc.id,
            revision: doc.revision,
            content,
            summary,
            createdAt: new Date().toISOString(),
          };
          await this.saveMetadata({ ...this.metadata, proposals: [...this.metadata.proposals, p] });
          return {
            id: p.id,
            fileId: p.fileId,
            summary: p.summary,
            message: '建议已提交，等待用户在知识工作区预览和应用；原文件未修改。',
          };
        }
        case 'proposal': {
          const p = this.metadata.proposals.find((x) => x.id === payload.id);
          if (!p) throw Error('未找到这条建议。');
          const doc = await this.readDocument(p.fileId);
          return { proposal: p, current: doc };
        }
        case 'reject-proposal': {
          const i = this.metadata.proposals.findIndex((x) => x.id === payload.id);
          if (i < 0) throw Error('未找到这条建议。');
          await this.saveMetadata({
            ...this.metadata,
            proposals: this.metadata.proposals.filter((_, index) => index !== i),
          });
          return { rejected: true };
        }
        case 'apply-proposal': {
          const i = this.metadata.proposals.findIndex((x) => x.id === payload.id);
          if (i < 0) throw Error('未找到这条建议。');
          const p = this.metadata.proposals[i]!;
          const result = await this.writeDocument(p.fileId, p.content, p.revision);
          await this.saveMetadata({
            ...this.metadata,
            proposals: this.metadata.proposals.filter((_, index) => index !== i),
          });
          return result;
        }
        default:
          throw Error('不支持的知识工作区操作。');
      }
    });
  }
}
