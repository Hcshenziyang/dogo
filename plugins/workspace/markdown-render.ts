import MarkdownIt from 'markdown-it';

type Note = { id: string; title: string; kind: string };
export type WorkspaceNote = Note;

export function resolveNote(target: string, notes: Note[]): Note | undefined {
  const name = target.split('#', 1)[0]?.trim().replace(/\.md$/i, '') || '';
  if (!name) return undefined;
  const candidates = notes.filter((note) => note.kind === 'note');
  return (
    candidates.find((note) => note.id.toLocaleLowerCase() === (name + '.md').toLocaleLowerCase()) ||
    candidates.find((note) => note.title.toLocaleLowerCase() === name.toLocaleLowerCase())
  );
}

export const markdownRenderer = new MarkdownIt({ html: false, linkify: false, typographer: false });
markdownRenderer.core.ruler.after('inline', 'workspace-task-list', (state) => {
  for (let index = 2; index < state.tokens.length; index++) {
    const token = state.tokens[index]!;
    if (
      token.type !== 'inline' ||
      state.tokens[index - 1]?.type !== 'paragraph_open' ||
      state.tokens[index - 2]?.type !== 'list_item_open' ||
      !token.children?.length
    )
      continue;
    const first = token.children[0]!;
    const match = first.type === 'text' && first.content.match(/^\[([ xX])\]\s+/);
    if (!match) continue;
    first.content = first.content.slice(match[0].length);
    const checkbox = new state.Token('html_inline', '', 0);
    checkbox.content = `<input type="checkbox" disabled${match[1]!.toLowerCase() === 'x' ? ' checked' : ''}> `;
    token.children.unshift(checkbox);
  }
});
markdownRenderer.inline.ruler.before('link', 'workspace-wikilink', (state, silent) => {
  const start = state.pos;
  const image = state.src.startsWith('![[', start);
  if (!image && !state.src.startsWith('[[', start)) return false;
  const end = state.src.indexOf(']]', start + (image ? 3 : 2));
  if (end < 0) return false;
  const body = state.src.slice(start + (image ? 3 : 2), end);
  const [target = '', label] = body.split('|', 2);
  if (!target.trim()) return false;
  if (!silent) {
    if (image) {
      const token = state.push('image', 'img', 0);
      token.attrSet('src', target.trim());
      token.content = label || target.trim();
      token.children = [];
    } else {
      const open = state.push('link_open', 'a', 1);
      open.attrSet('href', '#');
      open.attrSet('data-wiki', target.trim());
      const text = state.push('text', '', 0);
      text.content = label || target.trim();
      state.push('link_close', 'a', -1);
    }
  }
  state.pos = end + 2;
  return true;
});
const defaultImage = markdownRenderer.renderer.rules.image!;
markdownRenderer.renderer.rules.image = (tokens, index, options, env, self) => {
  const token = tokens[index]!;
  const src = token.attrGet('src') || '';
  if (/^https?:\/\//i.test(src)) return defaultImage(tokens, index, options, env, self);
  if (/^[a-z][a-z\d+.-]*:/i.test(src) || src.startsWith('//') || src.startsWith('/')) {
    return markdownRenderer.utils.escapeHtml(token.content || '不支持的图片');
  }
  const escape = markdownRenderer.utils.escapeHtml;
  return `<img class="dw-local-image" data-image-path="${escape(src)}" alt="${escape(token.content || '')}">`;
};

export async function readImage(
  control: (method: string, payload?: any) => Promise<any>,
  path: string,
): Promise<string> {
  let offset = 0;
  let type = '';
  let size = 0;
  const chunks: Uint8Array[] = [];
  do {
    const result = await control('image-read', { path, offset });
    if (offset && (result.size !== size || result.type !== type))
      throw Error('图片读取时发生变化。');
    size = result.size;
    type = result.type;
    const raw = atob(result.data);
    const bytes = Uint8Array.from(raw, (c) => c.charCodeAt(0));
    if (!bytes.length || offset + bytes.length > size) throw Error('图片读取失败。');
    chunks.push(bytes);
    offset += bytes.length;
  } while (offset < size);
  return URL.createObjectURL(new Blob(chunks as BlobPart[], { type }));
}

export async function uploadImage(
  control: (method: string, payload?: any) => Promise<any>,
  file: File,
): Promise<string> {
  if (file.size > 10 * 1024 * 1024 || !file.size) throw Error('图片大小须在 10 MiB 以内。');
  const { id } = await control('image-upload-start', { type: file.type });
  try {
    for (let offset = 0; offset < file.size; offset += 512 * 1024) {
      const bytes = new Uint8Array(await file.slice(offset, offset + 512 * 1024).arrayBuffer());
      let binary = '';
      for (let i = 0; i < bytes.length; i += 0x8000)
        binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      await control('image-upload-chunk', { id, data: btoa(binary) });
    }
    return (await control('image-upload-finish', { id })).path;
  } catch (error) {
    await control('image-upload-cancel', { id }).catch(() => {});
    throw error;
  }
}
