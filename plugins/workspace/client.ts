import { createUI } from '../shared/ui.js';
import { EditorView } from '@codemirror/view';
import { createMarkdownEditor } from './markdown-editor.js';
import { markdownRenderer, readImage, resolveNote } from './markdown-render.js';
import { styles } from './styles.js';

declare const window: any;
type Dict = Record<string, any>;
type Control = (method: string, payload?: Dict) => Promise<any>;
interface Draft extends Dict {
  id: string;
  title: string;
  kind: 'note' | 'canvas';
  content: string;
  revision: string;
  dirty: boolean;
}

window.__ModuleLoader__.load({
  id: 'dogo-workspace/client',
  factory: (require: any) => {
    const React = require('react'),
      h = React.createElement;
    const { Icon } = createUI(React);
    const MarkdownEditor = createMarkdownEditor(React);
    const PageContext = React.createContext(null);
    const draftKey = (vaultId: string, id: string) =>
      'dogo.workspace.draft.v2:' + vaultId + ':' + id;
    const legacyDraftKey = (id: string) => 'dogo.workspace.draft.v1:' + id;
    const errorText = (e: unknown) => (e as Error)?.message || String(e);
    const makeId = () => globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2);
    const btn = (label: string, onClick: () => void, extra: Dict = {}) =>
      h(
        'button',
        { type: 'button', className: 'dw-btn ' + (extra.className || ''), ...extra, onClick },
        label,
      );
    function ActionDialog({ action, name, setName, busy, error, close, submit }: any) {
      const panel = React.useRef(null as HTMLElement | null);
      React.useEffect(() => {
        const previous = document.activeElement as HTMLElement | null;
        const target = panel.current?.querySelector('input') || panel.current;
        (target as HTMLElement | null)?.focus();
        return () => {
          if (previous?.isConnected && !previous.closest('[inert]')) previous.focus();
        };
      }, []);
      const isCreate = action.type === 'create';
      const title = isCreate
        ? action.kind === 'note'
          ? '新建笔记'
          : '新建画布'
        : action.type === 'delete'
          ? '删除内容？'
          : '重新加载？';
      const description =
        action.type === 'delete'
          ? '删除「' + action.title + '」后，文件会从本机知识库中移除。'
          : action.type === 'reload'
            ? '重新加载会丢弃编辑区尚未保存的草稿。'
            : '';
      return h(
        'div',
        {
          className: 'dw-overlay',
          onMouseDown: (e: any) => {
            if (e.target === e.currentTarget && !busy) close();
          },
        },
        h(
          'section',
          {
            className: 'dw-dialog dw-dialog-compact',
            role: 'dialog',
            'aria-modal': true,
            'aria-label': title,
            tabIndex: -1,
            ref: panel,
            onKeyDown: (e: any) => {
              if (e.key === 'Escape' && !busy) {
                e.preventDefault();
                e.stopPropagation();
                close();
              }
              if (e.key !== 'Tab') return;
              const nodes = [
                ...(panel.current?.querySelectorAll(
                  'button:not(:disabled),input:not(:disabled),textarea:not(:disabled),[tabindex="0"]',
                ) || []),
              ] as HTMLElement[];
              if (!nodes.length) {
                e.preventDefault();
                return;
              }
              const first = nodes[0],
                last = nodes[nodes.length - 1];
              if (
                e.shiftKey &&
                (document.activeElement === first || document.activeElement === panel.current)
              ) {
                e.preventDefault();
                last?.focus();
              } else if (!e.shiftKey && document.activeElement === last) {
                e.preventDefault();
                first?.focus();
              }
            },
          },
          h(
            'form',
            {
              onSubmit: (e: any) => {
                e.preventDefault();
                submit();
              },
            },
            h(
              'div',
              { className: 'dw-dialog-head' },
              h('h2', null, title),
              h('span', { className: 'dw-spacer' }),
              btn('关闭', close, { disabled: busy, 'aria-label': '关闭对话框' }),
            ),
            h(
              'div',
              { className: 'dw-dialog-body' },
              isCreate
                ? h(
                    'label',
                    { className: 'dw-dialog-field' },
                    h('span', null, '名称'),
                    h('input', {
                      value: name,
                      onChange: (e: any) => setName(e.target.value),
                      required: true,
                      maxLength: 100,
                      autoComplete: 'off',
                      placeholder: action.kind === 'note' ? '给笔记起个名字' : '给画布起个名字',
                      'aria-label': action.kind === 'note' ? '新笔记名称' : '新画布名称',
                    }),
                  )
                : h('p', null, description),
              error && h('div', { className: 'dw-dialog-error', role: 'alert' }, error),
            ),
            h(
              'div',
              { className: 'dw-dialog-foot' },
              btn('取消', close, { className: 'line', disabled: busy }),
              h(
                'button',
                {
                  type: 'submit',
                  className: 'dw-btn ' + (action.type === 'delete' ? 'danger line' : 'primary'),
                  disabled: busy,
                },
                busy
                  ? '处理中…'
                  : isCreate
                    ? '创建'
                    : action.type === 'delete'
                      ? '删除'
                      : '重新加载',
              ),
            ),
          ),
        ),
      );
    }
    function MarkdownReader({ value, control, onWiki, onExternal }: any) {
      const container = React.useRef(null as HTMLElement | null);
      const html = React.useMemo(() => markdownRenderer.render(value), [value]);
      React.useEffect(() => {
        const urls: string[] = [];
        let alive = true;
        const root = container.current;
        if (!root) return;
        for (const image of Array.from(
          root.querySelectorAll('img[data-image-path]'),
        ) as HTMLImageElement[]) {
          const path = image.dataset.imagePath;
          if (!path) continue;
          void readImage(control, path)
            .then((url) => {
              if (!alive) {
                URL.revokeObjectURL(url);
                return;
              }
              urls.push(url);
              image.src = url;
            })
            .catch(() => {
              image.alt = (image.alt || path) + '（图片不可用）';
            });
        }
        return () => {
          alive = false;
          urls.forEach((url) => URL.revokeObjectURL(url));
        };
      }, [html, control]);
      return h('div', {
        ref: container,
        className: 'dw-reader',
        'aria-label': '笔记阅读',
        dangerouslySetInnerHTML: { __html: html },
        onClick: (event: any) => {
          const link = (event.target as Element).closest('a');
          if (!link) return;
          event.preventDefault();
          const wiki = link.getAttribute('data-wiki');
          const href = link.getAttribute('href') || '';
          if (wiki) onWiki(wiki);
          else if (/^https?:\/\//i.test(href)) onExternal(href);
          else if (href && !/^(?:[a-z][a-z\d+.-]*:|\/|#)/i.test(href)) {
            try {
              onWiki(decodeURIComponent(href));
            } catch {
              onWiki(href);
            }
          }
        },
      });
    }
    function FixedChat(props: any) {
      return props.renderSlot('conversation.session', { view: 'chat' });
    }
    function PagePicker() {
      const page = React.useContext(PageContext) as any;
      if (!page) return null;
      return h(
        'label',
        { className: 'dw-context' },
        h('span', null, 'AI 参考页面'),
        h(
          'select',
          {
            'aria-label': 'AI 参考页面',
            value: page.selected,
            onChange: (e: any) => page.setSelected(e.target.value),
          },
          h('option', { value: 'follow' }, '跟随当前 · ' + page.currentLabel),
          h('option', { value: 'tasks' }, '待办'),
          ...page.documents.map((item: Dict) =>
            h(
              'option',
              { key: item.id, value: 'doc:' + item.id },
              (item.kind === 'canvas' ? '画布 · ' : '笔记 · ') + item.title,
            ),
          ),
        ),
      );
    }
    function EmbeddedChat({
      sessionId,
      useSession,
      useConversation,
      useSessions,
      renderFactorySlot,
    }: any) {
      const session = useSession((x: any) => x),
        conversation = useConversation((x: any) => x);
      const summaryBlank = useSessions((s: any) => s.byId[sessionId]?.blank);
      if (!session || !conversation) return h('div', { className: 'dw-empty' }, '正在打开会话…');
      const active =
        (conversation.activeTargets?.size || 0) > 0 ||
        (!session.blank && !session.awaitingFirstTurn) ||
        session.running;
      const blank = !active && !session.promptAttempted;
      const settling = blank && session.openState === 'loading' && summaryBlank !== true;
      // A knowledge Session has a fixed local directory, not a selected DSH Workspace.
      // Do not show the ordinary empty-session Workspace picker in this embedded occurrence.
      return renderFactorySlot(
        'conversation.content',
        { variant: 'embedded', phase: settling ? 'settling' : 'active', hero: false },
        { slots: { views: FixedChat } },
      );
    }
    function Panel({
      control,
      layout,
      sessions,
      conversation,
      SessionProvider,
      renderSlot,
      vault,
      onSwitchVault,
    }: any) {
      const [status, setStatus] = React.useState(null as Dict | null),
        [listing, setListing] = React.useState({ documents: [], tasks: [] } as Dict);
      const [doc, setDoc] = React.useState(null as Draft | null),
        [mode, setMode] = React.useState('note');
      const [search, setSearch] = React.useState(''),
        [filter, setFilter] = React.useState('open'),
        [sourceMode, setSourceMode] = React.useState(false),
        [reading, setReading] = React.useState(false),
        [history, setHistory] = React.useState([] as any[]);
      const [selectedPage, setSelectedPage] = React.useState('follow'),
        [syncedContext, setSyncedContext] = React.useState(''),
        [contextError, setContextError] = React.useState(''),
        [contextRetry, setContextRetry] = React.useState(0),
        [navigating, setNavigating] = React.useState(false);
      const [error, setError] = React.useState(''),
        [notice, setNotice] = React.useState('');
      const [review, setReview] = React.useState(null as Dict | null),
        [showTree, setShowTree] = React.useState(false),
        [showAi, setShowAi] = React.useState(false);
      const [actionDialog, setActionDialog] = React.useState(null as Dict | null),
        [newName, setNewName] = React.useState(''),
        [dialogError, setDialogError] = React.useState(''),
        [dialogBusy, setDialogBusy] = React.useState(false);
      const [reference, setReference] = React.useState(null as any),
        [starting, setStarting] = React.useState(false);
      const [connecting, setConnecting] = React.useState('' as string),
        [taskText, setTaskText] = React.useState('');
      const draft = React.useRef(null as Draft | null),
        saveTimer = React.useRef(null as any),
        saving = React.useRef(null as Promise<void> | null),
        uploads = React.useRef(new Set<Promise<unknown>>()),
        mounted = React.useRef(true);
      const referenceRef = React.useRef(null as any),
        editor = React.useRef(null as any),
        contextOwner = React.useRef(makeId()),
        contextQueue = React.useRef(Promise.resolve() as Promise<unknown>),
        navigation = React.useRef(0),
        editorRestore = React.useRef(null as any),
        editPosition = React.useRef(null as any),
        contentScroll = React.useRef(null as HTMLElement | null);
      const imageControl = React.useCallback(
        async (method: string, payload: Dict = {}) => {
          const id = draft.current?.id as string | undefined;
          const result = await control(method, { ...payload, documentId: id });
          if (method === 'image-upload-finish' && id && result?.path) {
            const depth = id.split('/').length - 1;
            return { ...result, path: '../'.repeat(depth) + result.path };
          }
          return result;
        },
        [control],
      );
      const refresh = async () => {
        const [s, list] = await Promise.all([control('status'), control('list')]);
        if (mounted.current) {
          setStatus(s);
          setListing(list);
        }
        return { s, list };
      };
      const showError = (e: unknown) => {
        if (mounted.current) setError(errorText(e));
      };
      const report = (p: Promise<unknown>) => {
        void p.catch(showError);
      };
      function cacheDraft(value: Draft) {
        try {
          localStorage.setItem(
            draftKey(vault.id, value.id),
            JSON.stringify({ content: value.content, revision: value.revision }),
          );
        } catch {
          setError('浏览器未能保存临时草稿，请等待本机文件保存完成。');
        }
      }
      function clearDraft(id: string) {
        try {
          localStorage.removeItem(draftKey(vault.id, id));
        } catch {}
      }
      function install(value: Dict) {
        let current: Draft = {
          ...value,
          id: value.id,
          title: value.title,
          kind: value.kind,
          content: value.content,
          revision: value.revision,
          dirty: false,
        };
        try {
          let encoded = localStorage.getItem(draftKey(vault.id, value.id));
          if (!encoded && vault.legacy) {
            encoded = localStorage.getItem(legacyDraftKey(value.id));
            if (encoded) {
              localStorage.setItem(draftKey(vault.id, value.id), encoded);
              localStorage.removeItem(legacyDraftKey(value.id));
            }
          }
          const saved = JSON.parse(encoded || 'null');
          if (saved && typeof saved.content === 'string' && typeof saved.revision === 'string') {
            if (saved.content === value.content) clearDraft(value.id);
            else {
              current = {
                ...current,
                content: saved.content,
                revision: saved.revision,
                dirty: true,
              };
              if (saved.revision !== value.revision)
                setError('文件已在其他位置修改，未保存草稿仍在编辑区。请复制草稿后重新加载。');
            }
          }
        } catch {}
        draft.current = current;
        setDoc({ ...current });
        if (current.dirty && current.revision === value.revision) {
          clearTimeout(saveTimer.current);
          saveTimer.current = setTimeout(() => report(flush()), 750);
        }
      }
      function updateContent(content: string) {
        const current = draft.current;
        if (!current) return;
        const next = { ...current, content, dirty: true };
        draft.current = next;
        setDoc(next);
        cacheDraft(next);
        clearTimeout(saveTimer.current);
        saveTimer.current = setTimeout(() => report(flush()), 750);
      }
      async function flush(): Promise<void> {
        clearTimeout(saveTimer.current);
        if (uploads.current.size) await Promise.all([...uploads.current]);
        if (saving.current) {
          await saving.current;
          if (draft.current?.dirty) return flush();
          return;
        }
        const current = draft.current;
        if (!current || !current.dirty) return;
        const snapshot = { ...current };
        const operation = (async () => {
          const saved = await control('save', {
            id: snapshot.id,
            content: snapshot.content,
            revision: snapshot.revision,
          });
          const latest = draft.current;
          if (!latest || latest.id !== snapshot.id) return;
          const next = {
            ...latest,
            title: saved.title,
            revision: saved.revision,
            dirty: latest.content !== snapshot.content,
          };
          draft.current = next;
          if (mounted.current) setDoc({ ...next });
          if (next.dirty) cacheDraft(next);
          else clearDraft(snapshot.id);
          if (mounted.current) {
            setError('');
            void refresh().catch(showError);
          }
        })();
        saving.current = operation;
        try {
          await operation;
        } finally {
          if (saving.current === operation) saving.current = null;
        }
        if (draft.current?.id === snapshot.id && draft.current.dirty) return flush();
      }
      async function openDocument(id: string) {
        const ticket = ++navigation.current;
        setNavigating(true);
        try {
          await flush();
          const value = await control('get', { id });
          if (navigation.current !== ticket) return;
          install(value);
          setMode(value.kind);
          setConnecting('');
          setShowTree(false);
          setError('');
        } finally {
          if (navigation.current === ticket) setNavigating(false);
        }
      }
      function savePosition() {
        const selection = editor.current?.state.selection.main;
        return {
          id: draft.current?.id,
          anchor: selection?.anchor || 0,
          head: selection?.head || 0,
          scrollTop: contentScroll.current?.scrollTop || 0,
        };
      }
      async function openWiki(target: string) {
        const note = target.startsWith('#')
          ? listing.documents.find((item: Dict) => item.id === draft.current?.id)
          : resolveNote(target, listing.documents, draft.current?.id);
        if (!note) throw Error('未找到笔记：' + target);
        const current = savePosition();
        await openDocument(note.id);
        if (current.id && current.id !== note.id) setHistory((items: any[]) => [...items, current]);
        editorRestore.current = null;
        const heading = target.includes('#') ? target.slice(target.indexOf('#') + 1).trim() : '';
        requestAnimationFrame(() => {
          if (!heading) {
            if (contentScroll.current) contentScroll.current.scrollTop = 0;
            return;
          }
          if (reading) {
            const headings = Array.from(
              contentScroll.current?.querySelectorAll(
                '.dw-reader h1,.dw-reader h2,.dw-reader h3,.dw-reader h4,.dw-reader h5,.dw-reader h6',
              ) || [],
            );
            const match = headings.find(
              (item: any) => item.textContent?.trim().toLowerCase() === heading.toLowerCase(),
            );
            if (match) {
              (match as HTMLElement).scrollIntoView({ block: 'start' });
              return;
            }
          } else if (editor.current) {
            const text = editor.current.state.doc;
            for (let number = 1; number <= text.lines; number++) {
              const line = text.line(number);
              const title = line.text.match(/^#{1,6}\s+(.+?)\s*#*\s*$/)?.[1];
              if (title?.trim().toLowerCase() === heading.toLowerCase()) {
                editor.current.dispatch({
                  selection: { anchor: line.from },
                  effects: EditorView.scrollIntoView(line.from, { y: 'center' }),
                });
                editor.current.focus();
                return;
              }
            }
          }
          setError('未找到标题：' + heading);
        });
      }
      async function goBack() {
        const position = history[history.length - 1];
        if (!position) return;
        editorRestore.current = position;
        try {
          await openDocument(position.id);
          setHistory((items: any[]) => items.slice(0, -1));
          requestAnimationFrame(() => {
            if (contentScroll.current) contentScroll.current.scrollTop = position.scrollTop;
          });
        } catch (error) {
          editorRestore.current = null;
          throw error;
        }
      }
      function openExternal(href: string) {
        if (/^https?:\/\//i.test(href)) window.open(href, '_blank', 'noopener,noreferrer');
      }
      function toggleReading() {
        if (!reading) editPosition.current = savePosition();
        setReading(!reading);
        if (reading)
          requestAnimationFrame(() => {
            editor.current?.requestMeasure();
            if (editPosition.current?.id === draft.current?.id) {
              const { anchor, head, scrollTop } = editPosition.current;
              const length = editor.current?.state.doc.length ?? 0;
              editor.current?.dispatch({
                selection: { anchor: Math.min(anchor, length), head: Math.min(head, length) },
              });
              if (contentScroll.current) contentScroll.current.scrollTop = scrollTop;
            }
            editor.current?.focus();
          });
      }
      async function switchTasks() {
        const ticket = ++navigation.current;
        setNavigating(true);
        try {
          await flush();
          if (navigation.current !== ticket) return;
          setMode('tasks');
          setShowTree(false);
          setConnecting('');
          await refresh();
        } finally {
          if (navigation.current === ticket) setNavigating(false);
        }
      }
      async function create(kind: 'note' | 'canvas') {
        await flush();
        setNewName('');
        setDialogError('');
        setActionDialog({ type: 'create', kind });
      }
      async function removeCurrent() {
        await flush();
        const value = draft.current;
        if (!value) return;
        setDialogError('');
        setActionDialog({ type: 'delete', id: value.id, title: value.title });
      }
      async function reloadCurrent() {
        const value = draft.current;
        if (!value) return;
        if (value.dirty) {
          setDialogError('');
          setActionDialog({ type: 'reload', id: value.id });
          return;
        }
        await reloadConfirmed(value.id);
        await refresh();
      }
      async function reloadConfirmed(id: string) {
        if (draft.current?.id !== id) throw Error('当前内容已改变，请重新操作。');
        clearTimeout(saveTimer.current);
        const next = await control('get', { id });
        // Keep the draft until the new file has actually been read.
        clearDraft(id);
        install(next);
        setError('');
      }
      async function submitActionDialog() {
        if (!actionDialog || dialogBusy) return;
        setDialogBusy(true);
        setDialogError('');
        let committed = false;
        try {
          if (actionDialog.type === 'create') {
            const title = newName.trim();
            if (!title) throw Error('请输入名称。');
            const value = await control(actionDialog.kind === 'note' ? 'create' : 'create-canvas', {
              title,
            });
            committed = true;
            install(value);
            setMode(actionDialog.kind);
            setShowTree(false);
            await refresh();
          } else if (actionDialog.type === 'delete') {
            const value = draft.current;
            if (!value || value.id !== actionDialog.id) throw Error('当前内容已改变，请重新操作。');
            await control('delete', { id: value.id, revision: value.revision });
            committed = true;
            clearDraft(value.id);
            draft.current = null;
            setDoc(null);
            const next = await refresh();
            const first = next.list.documents.find((d: Dict) => d.kind === 'note');
            if (first) await openDocument(first.id);
          } else if (actionDialog.type === 'reload') {
            await reloadConfirmed(actionDialog.id);
            committed = true;
            await refresh();
          }
          if (mounted.current) setActionDialog(null);
        } catch (e) {
          if (committed && mounted.current) {
            setActionDialog(null);
            showError(e);
          } else if (mounted.current) setDialogError(errorText(e));
        } finally {
          if (mounted.current) setDialogBusy(false);
        }
      }
      async function addTask() {
        const text = taskText.trim();
        if (!text) return;
        await flush();
        const target =
          listing.documents.find((x: Dict) => x.kind === 'note' && x.id === draft.current?.id) ||
          listing.documents.find((x: Dict) => x.kind === 'note');
        if (!target) throw Error('请先新建一篇笔记，再添加待办。');
        const value = await control('get', { id: target.id });
        const next = await control('save', {
          id: value.id,
          revision: value.revision,
          content:
            value.content.replace(/\s*$/, '') + '\n\n- [ ] ' + text.replace(/[\r\n]+/g, ' ') + '\n',
        });
        if (draft.current?.id === next.id) install(next);
        setTaskText('');
        await refresh();
      }
      async function toggleTask(task: Dict, done: boolean) {
        await flush();
        const result = await control('toggle-task', {
          id: task.fileId,
          line: task.line,
          revision: task.revision,
          done,
        });
        if (draft.current?.id === result.id) install(result);
        await refresh();
      }
      function mutateCanvas(change: (value: any) => void) {
        const current = draft.current;
        if (!current || current.kind !== 'canvas') return;
        let value;
        try {
          value = JSON.parse(current.content);
        } catch {
          setError('画布文件不是有效的 JSON，请在外部修复后重新加载。');
          return;
        }
        if (!Array.isArray(value.nodes) || !Array.isArray(value.edges)) {
          setError('画布缺少 nodes 或 edges。');
          return;
        }
        change(value);
        updateContent(JSON.stringify(value, null, 2) + '\n');
      }
      function canvasClick(id: string) {
        if (!connecting) return;
        if (connecting === 'pick') {
          setConnecting(id);
          return;
        }
        if (connecting === id) {
          setConnecting('');
          return;
        }
        mutateCanvas((value) =>
          value.edges.push({
            id: makeId(),
            fromNode: connecting,
            fromSide: 'bottom',
            toNode: id,
            toSide: 'top',
          }),
        );
        setConnecting('');
      }
      function beginDrag(e: any, node: any) {
        if (e.button !== 0 || connecting || e.target.closest('textarea,button')) return;
        e.preventDefault();
        const sx = e.clientX,
          sy = e.clientY,
          x = node.x,
          y = node.y;
        const move = (event: PointerEvent) =>
          mutateCanvas((value) => {
            const n = value.nodes.find((n: any) => n.id === node.id);
            if (n) {
              n.x = Math.max(0, Math.round(x + event.clientX - sx));
              n.y = Math.max(0, Math.round(y + event.clientY - sy));
            }
          });
        const up = () => {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
          window.removeEventListener('pointercancel', up);
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up, { once: true });
        window.addEventListener('pointercancel', up, { once: true });
      }
      async function loadReference(id: string) {
        const ref = sessions.retain(id, { source: 'dogoWorkspace' });
        try {
          const binding = await ref.ready;
          if (binding.session.getSnapshot().openState === 'error')
            throw Error('知识工作区会话打开失败，请检查 Harness 会话状态。');
        } catch (e) {
          ref.release();
          throw e;
        }
        if (!mounted.current) {
          ref.release();
          return;
        }
        referenceRef.current?.release();
        referenceRef.current = ref;
        setReference(ref);
      }
      async function startChat() {
        if (starting || referenceRef.current) return;
        setStarting(true);
        try {
          let id = status?.activeSession,
            created = false;
          if (!id) {
            id = await sessions.create({ cwd: status.directory });
            await control('bind-session', { id });
            await refresh();
            created = true;
          }
          await loadReference(id);
          if (created && referenceRef.current) {
            const result = await referenceRef.current.binding.session.rename('知识工作区');
            if (!result.ok) throw Error(result.error?.message || '会话命名失败。');
          }
        } finally {
          if (mounted.current) setStarting(false);
        }
      }
      function quoteCurrent() {
        const current = draft.current,
          ref = referenceRef.current;
        if (!current || !ref) {
          setError('请先开启 AI 对话。');
          return;
        }
        const selection = editor.current?.state.selection.main;
        const readSelection = window.getSelection?.();
        const selected = reading
          ? readSelection?.anchorNode &&
            contentScroll.current?.querySelector('.dw-reader')?.contains(readSelection.anchorNode)
            ? readSelection.toString() || current.content
            : current.content
          : selection && selection.from !== selection.to
            ? editor.current.state.sliceDoc(selection.from, selection.to)
            : current.content;
        if (!selected.trim()) {
          setError('当前内容为空。');
          return;
        }
        if (selected.length > 50000) {
          setError('内容过长，请先选择需要讨论的文字。');
          return;
        }
        const input = conversation.input.for(ref.binding.ctx);
        if (!input.actions.insertQuote('知识库 · ' + current.title + '\n' + selected))
          throw Error('当前会话暂时不能插入引用，请稍后重试。');
        setNotice('已加入会话草稿，发送后 AI 才会收到。');
        setShowAi(true);
      }
      async function openReview(id: string) {
        await flush();
        setReview(await control('proposal', { id }));
      }
      async function rejectReview() {
        if (!review) return;
        await control('reject-proposal', { id: review.proposal.id });
        setReview(null);
        await refresh();
      }
      async function applyReview() {
        if (!review) return;
        await flush();
        const value = await control('apply-proposal', { id: review.proposal.id });
        if (draft.current?.id === value.id) install(value);
        setReview(null);
        await refresh();
        setNotice('建议已应用。');
      }
      React.useEffect(() => {
        mounted.current = true;
        let alive = true;
        const releaseContext = () => {
          const sessionId = referenceRef.current?.sessionId;
          if (sessionId)
            void control('clear-page-context', { sessionId, owner: contextOwner.current }).catch(
              () => {},
            );
        };
        window.addEventListener('pagehide', releaseContext);
        void refresh()
          .then(async ({ s, list }) => {
            if (!alive) return;
            const first = list.documents.find((x: Dict) => x.kind === 'note') || list.documents[0];
            if (first) {
              const initial = await control('get', { id: first.id });
              if (alive) {
                install(initial);
                setMode(initial.kind);
              }
            }
            if (s.activeSession && alive) await loadReference(s.activeSession);
          })
          .catch(showError);
        const timer = setInterval(() => {
          if (!document.hidden)
            void control('status')
              .then((s: Dict) => {
                if (alive) setStatus(s);
              })
              .catch(() => {});
        }, 2500);
        return () => {
          alive = false;
          mounted.current = false;
          clearTimeout(saveTimer.current);
          clearInterval(timer);
          window.removeEventListener('pagehide', releaseContext);
          const sessionId = referenceRef.current?.sessionId;
          if (sessionId)
            void contextQueue.current
              .finally(() =>
                control('clear-page-context', {
                  sessionId,
                  owner: contextOwner.current,
                }),
              )
              .catch(() => {});
          referenceRef.current?.release();
          referenceRef.current = null;
        };
      }, []);
      React.useEffect(() => {
        if (!notice) return;
        const t = setTimeout(() => setNotice(''), 4000);
        return () => clearTimeout(t);
      }, [notice]);
      const documents = listing.documents as Dict[],
        tasks = listing.tasks as Dict[];
      const documentTitle =
        doc?.kind === 'note'
          ? doc.content.match(/^#[ \t]+([^\r\n]+)\s*$/m)?.[1]?.trim() || doc.id.slice(0, -3)
          : doc?.title;
      const currentPage =
        mode === 'tasks'
          ? { kind: 'tasks' }
          : doc
            ? { kind: doc.kind, id: doc.id, title: documentTitle }
            : { kind: 'none' };
      const currentLabel = mode === 'tasks' ? '待办' : documentTitle || '未打开页面';
      const chosen = selectedPage.startsWith('doc:')
        ? documents.find((item) => item.id === selectedPage.slice(4))
        : null;
      const referencePage =
        selectedPage === 'follow'
          ? currentPage
          : selectedPage === 'tasks'
            ? { kind: 'tasks' }
            : chosen
              ? {
                  kind: chosen.kind,
                  id: chosen.id,
                  title: chosen.id === doc?.id ? documentTitle : chosen.title,
                }
              : { kind: 'none' };
      const sessionId = reference?.sessionId as string | undefined;
      const contextPayload = {
        sessionId,
        owner: contextOwner.current,
        selection: selectedPage === 'follow' ? 'follow' : 'manual',
        current: currentPage,
        reference: referencePage,
      };
      const contextKey = JSON.stringify(contextPayload);
      React.useEffect(() => {
        if (selectedPage.startsWith('doc:') && !chosen) setSelectedPage('follow');
      }, [selectedPage, Boolean(chosen)]);
      React.useEffect(() => {
        if (!sessionId) return;
        let active = true;
        setContextError('');
        const operation = contextQueue.current
          .catch(() => {})
          .then(() => control('set-page-context', contextPayload));
        contextQueue.current = operation;
        void operation
          .then(() => {
            if (active) setSyncedContext(contextKey);
          })
          .catch((e: unknown) => {
            if (active) setContextError(errorText(e));
          });
        return () => {
          active = false;
        };
      }, [sessionId, contextKey, contextRetry]);
      const contextPending = !!reference && (navigating || syncedContext !== contextKey);
      const matching = documents.filter((x) =>
        (x.title + ' ' + x.id).toLowerCase().includes(search.toLowerCase()),
      );
      const listButton = (x: Dict) =>
        h(
          'button',
          {
            key: x.id,
            type: 'button',
            className: 'dw-entry ' + (mode === x.kind && doc?.id === x.id ? 'active' : ''),
            onClick: () => report(openDocument(x.id)),
          },
          h(Icon, { name: x.kind === 'note' ? 'note' : 'grid', size: 15, className: 'dw-icon' }),
          h('span', { title: x.id }, x.id.includes('/') ? x.id : x.title),
        );
      const tree = h(
        'aside',
        { className: 'dw-tree' },
        h(
          'div',
          { className: 'dw-tree-top' },
          h('strong', { title: vault.directory }, vault.name),
          h('span', { className: 'dw-spacer' }),
          btn('切换', () => report(flush().then(onSwitchVault)), { title: '切换知识库' }),
          btn('+ 笔记', () => report(create('note')), { title: '新建笔记' }),
          btn('+ 画布', () => report(create('canvas')), { title: '新建画布' }),
        ),
        h(
          'div',
          { className: 'dw-tree-list' },
          h('input', {
            className: 'dw-search',
            placeholder: '搜索标题',
            value: search,
            onChange: (e: any) => setSearch(e.target.value),
            'aria-label': '搜索知识库',
          }),
          h('div', { className: 'dw-caption' }, '笔记'),
          ...matching.filter((x) => x.kind === 'note').map(listButton),
          h('div', { className: 'dw-caption' }, '工作视图'),
          h(
            'button',
            {
              className: 'dw-entry ' + (mode === 'tasks' ? 'active' : ''),
              onClick: () => report(switchTasks()),
            },
            h(Icon, { name: 'check', size: 15, className: 'dw-icon' }),
            h('span', null, '待办'),
          ),
          ...matching.filter((x) => x.kind === 'canvas').map(listButton),
          listing.skipped?.length > 0 &&
            h(
              'p',
              { className: 'dw-caption', title: listing.skipped.join('\n') },
              `有 ${listing.skipped.length} 个文件或目录无法读取`,
            ),
        ),
        h(
          'div',
          { className: 'dw-tree-foot', title: status?.directory },
          '本机知识库',
          h('br'),
          status?.directory || '正在连接…',
        ),
      );
      let content: any = null;
      if (mode === 'tasks') {
        const filtered = tasks.filter((t) => (filter === 'done' ? t.done : !t.done));
        content = h(
          'div',
          { className: 'dw-content' },
          h(
            'section',
            { className: 'dw-task-view' },
            h('h1', null, '待办'),
            h('p', null, '笔记中的复选项会在这里汇总。'),
            h(
              'form',
              {
                className: 'dw-task-add',
                onSubmit: (e: any) => {
                  e.preventDefault();
                  report(addTask());
                },
              },
              h('input', {
                value: taskText,
                onChange: (e: any) => setTaskText(e.target.value),
                placeholder: '记下一件要做的事…',
                'aria-label': '新待办',
              }),
              h('button', { type: 'submit', className: 'dw-btn primary' }, '添加'),
            ),
            h(
              'div',
              { className: 'dw-task-filters' },
              btn('未完成 ' + tasks.filter((t) => !t.done).length, () => setFilter('open'), {
                className: filter === 'open' ? 'active' : '',
              }),
              btn('已完成 ' + tasks.filter((t) => t.done).length, () => setFilter('done'), {
                className: filter === 'done' ? 'active' : '',
              }),
            ),
            ...(filtered.length
              ? filtered.map((t) =>
                  h(
                    'div',
                    { className: 'dw-task', key: t.id },
                    h('input', {
                      type: 'checkbox',
                      checked: t.done,
                      onChange: (e: any) => report(toggleTask(t, e.target.checked)),
                      'aria-label': t.text,
                    }),
                    h(
                      'div',
                      { className: 'dw-task-text' },
                      h('span', null, t.text),
                      h(
                        'small',
                        null,
                        '来自 ',
                        h(
                          'button',
                          { type: 'button', onClick: () => report(openDocument(t.fileId)) },
                          t.title,
                        ),
                      ),
                    ),
                  ),
                )
              : [h('div', { className: 'dw-empty', key: 'empty' }, '这里暂时没有事项。')]),
          ),
        );
      } else if (!doc) {
        content = h(
          'div',
          { className: 'dw-empty' },
          h('strong', null, '开始记录'),
          h('span', null, '新建一篇笔记，或打开一张画布。'),
          btn('新建笔记', () => report(create('note')), { className: 'primary' }),
        );
      } else if (mode === 'note') {
        content = h(
          'div',
          { className: 'dw-content', ref: contentScroll },
          h(
            'article',
            { className: 'dw-document' },
            h('div', { className: 'dw-kicker' }, '笔记  ·  本机知识库'),
            h(
              'div',
              {
                style: { display: reading ? 'none' : undefined },
                inert: navigating ? true : undefined,
              },
              h(MarkdownEditor, {
                key: doc.id,
                value: doc.content,
                source: sourceMode,
                notes: documents,
                control: imageControl,
                onWiki: (target: string) => report(openWiki(target)),
                onExternal: openExternal,
                onError: showError,
                onUpload: (upload: Promise<unknown>) => {
                  uploads.current.add(upload);
                  void upload.finally(() => uploads.current.delete(upload));
                },
                restore: editorRestore.current,
                onChange: updateContent,
                onBlur: () => report(flush()),
                onReady: (value: any) => {
                  editor.current = value;
                },
              }),
            ),
            reading &&
              h(MarkdownReader, {
                value: doc.content,
                control: imageControl,
                onWiki: (target: string) => report(openWiki(target)),
                onExternal: openExternal,
              }),
          ),
        );
      } else {
        let canvas: any;
        try {
          canvas = JSON.parse(doc.content);
        } catch {
          canvas = { nodes: [], edges: [] };
        }
        const nodes = Array.isArray(canvas.nodes) ? canvas.nodes : [],
          edges = Array.isArray(canvas.edges) ? canvas.edges : [];
        const lookup = new Map(nodes.map((n: Dict) => [n.id, n]));
        content = h(
          React.Fragment,
          null,
          h(
            'div',
            { className: 'dw-canvas-holder' },
            h(
              'div',
              { className: 'dw-canvas' },
              h(
                'svg',
                { className: 'dw-lines', width: 1100, height: 800 },
                h(
                  'defs',
                  null,
                  h(
                    'marker',
                    {
                      id: 'dw-arrow',
                      viewBox: '0 0 10 10',
                      refX: 8,
                      refY: 5,
                      markerWidth: 5,
                      markerHeight: 5,
                      orient: 'auto',
                    },
                    h('path', { d: 'M 0 0 L 10 5 L 0 10 z', fill: '#a4b9df' }),
                  ),
                ),
                ...edges.map((edge: Dict) => {
                  const a: any = lookup.get(edge.fromNode),
                    b: any = lookup.get(edge.toNode);
                  if (!a || !b) return null;
                  return h('line', {
                    key: edge.id,
                    x1: a.x + a.width / 2,
                    y1: a.y + a.height,
                    x2: b.x + b.width / 2,
                    y2: b.y,
                    stroke: '#a4b9df',
                    strokeWidth: 1.4,
                    markerEnd: 'url(#dw-arrow)',
                  });
                }),
              ),
              ...nodes.map((node: Dict) =>
                h(
                  'div',
                  {
                    className: 'dw-node ' + (connecting === node.id ? 'picked' : ''),
                    key: node.id,
                    style: { left: node.x, top: node.y, width: node.width, height: node.height },
                    onPointerDown: (e: any) => beginDrag(e, node),
                    onClick: () => canvasClick(node.id),
                  },
                  h('small', null, node.type === 'text' ? '文本卡片' : node.type),
                  node.type === 'text'
                    ? h('textarea', {
                        value: node.text || '',
                        onChange: (e: any) =>
                          mutateCanvas((value) => {
                            const n = value.nodes.find((x: Dict) => x.id === node.id);
                            if (n) n.text = e.target.value;
                          }),
                        'aria-label': '画布卡片文字',
                      })
                    : h('span', null, node.file || node.url || '暂不支持编辑此卡片'),
                ),
              ),
            ),
          ),
          h(
            'div',
            { className: 'dw-canvas-hint' },
            connecting
              ? '依次选择起点和终点；再次点击起点可取消。'
              : '拖动卡片调整位置，编辑卡片文字。',
          ),
        );
      }
      const toolbar =
        doc && mode !== 'tasks'
          ? h(
              'div',
              { className: 'dw-toolbar' },
              h('span', null, doc.kind === 'note' ? '笔记' : '画布'),
              h('span', null, ' / '),
              h('span', null, doc.title),
              h('span', { className: 'dw-spacer' }),
              h('span', null, doc.dirty ? '保存中…' : '已保存'),
              mode === 'canvas' &&
                btn('添加节点', () =>
                  mutateCanvas((value) =>
                    value.nodes.push({
                      id: makeId(),
                      type: 'text',
                      text: '新想法',
                      x: 220,
                      y: 180,
                      width: 190,
                      height: 90,
                    }),
                  ),
                ),
              mode === 'canvas' &&
                btn(
                  connecting ? '取消连线' : '连线',
                  () => setConnecting(connecting ? '' : 'pick'),
                  { className: connecting ? 'active' : '' },
                ),
              mode === 'note' && history.length > 0 && btn('返回笔记', () => report(goBack())),
              mode === 'note' &&
                btn(reading ? '编辑' : '阅读', toggleReading, { title: '切换阅读视图 (⌘E)' }),
              mode === 'note' &&
                !reading &&
                btn(sourceMode ? '实时预览' : '源码', () => setSourceMode(!sourceMode)),
              btn('引用到 AI', () => {
                try {
                  quoteCurrent();
                } catch (e) {
                  showError(e);
                }
              }),
              btn('重新加载', () => report(reloadCurrent())),
              btn('删除', () => report(removeCurrent()), { className: 'danger' }),
            )
          : null;
      const ai = h(
        'aside',
        { className: 'dw-ai' },
        h(
          'div',
          { className: 'dw-ai-head' },
          h('div', { className: 'dw-ai-mark' }, h(Icon, { name: 'chat', size: 15 })),
          h('div', null, h('strong', null, 'AI 辅助'), h('small', null, '知识工作区独立会话')),
          h('span', { className: 'dw-spacer' }),
          btn('关闭', () => setShowAi(false), { className: 'dw-head-mobile' }),
        ),
        reference &&
          contextPending &&
          h(
            'div',
            { className: 'dw-context-status', role: 'status' },
            contextError ? '页面同步失败：' + contextError : '正在更新页面上下文…',
            contextError && btn('重试', () => setContextRetry((x: number) => x + 1)),
          ),
        (status?.proposals || []).length > 0 &&
          h(
            'div',
            { className: 'dw-proposals' },
            ...(status.proposals as Dict[]).map((p) =>
              h(
                'button',
                { key: p.id, type: 'button', onClick: () => report(openReview(p.id)) },
                '查看修改建议 · ' + (p.summary || p.fileId),
              ),
            ),
          ),
        h(
          'div',
          { className: 'dw-ai-body', inert: contextPending ? '' : undefined },
          reference
            ? h(
                PageContext.Provider,
                {
                  value: {
                    selected: selectedPage,
                    setSelected: setSelectedPage,
                    currentLabel,
                    documents,
                  },
                },
                h(SessionProvider, { session: reference }, renderSlot('dogo.workspace.chat', {})),
              )
            : h(
                'div',
                { className: 'dw-empty' },
                h('strong', null, '与 AI 一起整理'),
                h('span', null, '开启独立会话，使用 Harness 中配置的模型。'),
                btn(starting ? '正在开启…' : '开启 AI 对话', () => report(startChat()), {
                  className: 'primary',
                  disabled: starting || !status,
                }),
              ),
        ),
        h('div', { className: 'dw-ai-help' }, '知识会话可读取笔记并提交建议；修改由你预览和应用。'),
      );
      const modal =
        review &&
        h(
          'div',
          {
            className: 'dw-overlay',
            onMouseDown: (e: any) => {
              if (e.target === e.currentTarget) setReview(null);
            },
          },
          h(
            'section',
            {
              className: 'dw-dialog',
              role: 'dialog',
              'aria-modal': true,
              'aria-label': 'AI 修改建议',
            },
            h(
              'div',
              { className: 'dw-dialog-head' },
              h(
                'div',
                null,
                h('h2', null, 'AI 修改建议'),
                h('p', null, review.proposal.summary || review.proposal.fileId),
              ),
              h('span', { className: 'dw-spacer' }),
              btn('关闭', () => setReview(null)),
            ),
            review.current.revision !== review.proposal.revision &&
              h(
                'div',
                { className: 'dw-modal-error' },
                '原文件已变化，不能直接应用；请让 AI 基于最新内容重新提出建议。',
              ),
            h(
              'div',
              { className: 'dw-diff' },
              h(
                'section',
                null,
                h('strong', null, '当前内容'),
                h('pre', null, review.current.content),
              ),
              h(
                'section',
                null,
                h('strong', null, '建议内容'),
                h('pre', null, review.proposal.content),
              ),
            ),
            h(
              'div',
              { className: 'dw-dialog-foot' },
              btn('放弃建议', () => report(rejectReview()), { className: 'line' }),
              btn('应用建议', () => report(applyReview()), {
                className: 'primary',
                disabled: review.current.revision !== review.proposal.revision,
              }),
            ),
          ),
        );
      return h(
        'div',
        {
          className: 'dw ' + (showTree ? 'show-tree ' : '') + (showAi ? 'show-ai' : ''),
          'data-dogo': 'workspace',
          onKeyDown: (event: any) => {
            if (
              mode === 'note' &&
              (event.metaKey || event.ctrlKey) &&
              event.key.toLowerCase() === 'e'
            ) {
              event.preventDefault();
              event.stopPropagation();
              toggleReading();
            }
          },
        },
        h('style', null, styles),
        h(
          'header',
          { className: 'dw-head' },
          btn('目录', () => setShowTree(!showTree), { className: 'dw-head-mobile line' }),
          h('span', { className: 'dw-dim' }, '知识工作区 /'),
          h('strong', null, mode === 'tasks' ? '待办' : doc?.title || '我的知识库'),
          h('span', { className: 'dw-spacer' }),
          btn('AI 辅助', () => setShowAi(!showAi), { className: 'dw-head-mobile line' }),
          btn('返回项目会话', () => report(flush().then(() => layout.selectPanel(null))), {
            className: 'line',
          }),
        ),
        (error || notice) &&
          h(
            'div',
            { className: 'dw-error', role: error ? 'alert' : 'status' },
            h('span', null, error || notice),
            btn('关闭', () => {
              setError('');
              setNotice('');
            }),
          ),
        h(
          'div',
          { className: 'dw-body' },
          tree,
          h('main', { className: 'dw-main' }, toolbar, content),
          ai,
        ),
        modal,
        actionDialog &&
          h(ActionDialog, {
            action: actionDialog,
            name: newName,
            setName: setNewName,
            busy: dialogBusy,
            error: dialogError,
            close: () => setActionDialog(null),
            submit: () => {
              void submitActionDialog();
            },
          }),
      );
    }
    function WorkspaceRoot(props: any) {
      const { control } = props;
      const [registry, setRegistry] = React.useState(null as Dict | null);
      const [selected, setSelected] = React.useState(null as Dict | null);
      const [choosing, setChoosing] = React.useState(false);
      const [path, setPath] = React.useState('');
      const [error, setError] = React.useState('');
      const [busy, setBusy] = React.useState(false);
      const scoped = React.useMemo(
        () =>
          selected
            ? (method: string, payload: Dict = {}) =>
                control(method, { ...payload, vaultId: selected.id })
            : null,
        [control, selected?.id],
      );
      React.useEffect(() => {
        let alive = true;
        void control('vault-list')
          .then((value: Dict) => {
            if (!alive) return;
            setRegistry(value);
            setSelected(value.vaults.find((item: Dict) => item.id === value.selected) || null);
          })
          .catch((reason: unknown) => {
            if (alive) setError(errorText(reason));
          });
        return () => {
          alive = false;
        };
      }, [control]);
      async function choose(method: string, payload: Dict = {}) {
        if (busy) return;
        setBusy(true);
        setError('');
        try {
          const next = await control(method, payload);
          if (!next) return;
          const value = await control('vault-list');
          setRegistry(value);
          setSelected(next);
          setChoosing(false);
          setPath('');
        } catch (reason) {
          setError(errorText(reason));
        } finally {
          setBusy(false);
        }
      }
      if (selected && !choosing && scoped)
        return h(Panel, {
          ...props,
          key: selected.id,
          control: scoped,
          vault: selected,
          onSwitchVault: () => {
            setChoosing(true);
            setError('');
          },
        });
      return h(
        'div',
        { className: 'dw dw-vault-screen', 'data-dogo': 'workspace' },
        h('style', null, styles),
        h(
          'section',
          { className: 'dw-vault-picker', 'aria-label': '选择知识库' },
          h('h1', null, '选择知识库'),
          h('p', null, '选择已有文件夹，或使用默认知识库。'),
          error && h('div', { className: 'dw-dialog-error', role: 'alert' }, error),
          !registry && !error && h('p', null, '正在加载…'),
          ...(registry?.vaults || []).map((item: Dict) =>
            h(
              'button',
              {
                key: item.id,
                className: 'dw-vault-item',
                type: 'button',
                disabled: busy,
                onClick: () => void choose('vault-select', { id: item.id }),
              },
              h('strong', null, item.name),
              h('small', null, item.directory),
            ),
          ),
          registry &&
            !registry.vaults.some((item: Dict) => item.legacy) &&
            h(
              'button',
              {
                type: 'button',
                className: 'dw-vault-item',
                disabled: busy,
                onClick: () =>
                  void choose('vault-open', { path: registry.defaultDirectory, useDefault: true }),
              },
              h('strong', null, '使用默认知识库'),
              h('small', null, registry.defaultDirectory),
            ),
          h(
            'div',
            { className: 'dw-vault-actions' },
            btn(busy ? '正在打开…' : '选择文件夹', () => void choose('vault-choose'), {
              className: 'primary',
              disabled: busy,
            }),
            selected &&
              btn(
                '返回当前知识库',
                () => {
                  setChoosing(false);
                  setError('');
                },
                { className: 'line', disabled: busy },
              ),
          ),
          h(
            'form',
            {
              className: 'dw-vault-path',
              onSubmit: (event: any) => {
                event.preventDefault();
                void choose('vault-open', { path: path.trim() });
              },
            },
            h(
              'label',
              null,
              '或输入文件夹的绝对路径',
              h('input', {
                value: path,
                onChange: (event: any) => setPath(event.target.value),
                placeholder: '/path/to/vault',
                'aria-label': '知识库目录',
              }),
            ),
            h(
              'button',
              { type: 'submit', className: 'dw-btn line', disabled: busy || !path.trim() },
              '打开',
            ),
          ),
        ),
      );
    }
    function apply(ctx: any) {
      const control: Control = async (method, payload = {}) => {
        const result = await ctx.connection.rpc.call('/dogo-workspace', method, payload);
        if (!result.ok) throw Error(result.error?.message || '知识工作区请求失败');
        return result.value;
      };
      ctx.slots.inject('main', () =>
        ctx.slots.register(
          {
            name: 'main',
            key: 'dogo-workspace',
            children: { 'dogo.workspace.chat': { kind: 'single', scope: 'session' } },
            inject: () => ({
              control,
              layout: ctx.layout,
              sessions: ctx.sessions,
              conversation: ctx.conversation,
            }),
          },
          WorkspaceRoot,
        ),
      );
      ctx.slots.inject('dogo.workspace.chat', () =>
        ctx.slots.register({ name: 'dogo.workspace.chat' }, EmbeddedChat),
      );
      ctx.slots.inject('conversation.input.dock', () =>
        ctx.slots.register(
          { name: 'conversation.input.dock', id: 'dogo-workspace-page', order: 10 },
          PagePicker,
        ),
      );
      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register(
          { name: 'sidebar.panellist', id: 'dogo-workspace', order: 12, label: () => '知识工作区' },
          ({ size }: any) => h(Icon, { name: 'folder', size }),
        ),
      );
      ctx.slots.inject('conversation.session.header.utilities', () =>
        ctx.slots.register(
          { name: 'conversation.session.header.utilities', id: 'dogo-workspace', order: 90 },
          () =>
            h(
              'button',
              {
                type: 'button',
                title: '打开知识工作区',
                'aria-label': '打开知识工作区',
                onClick: () => ctx.layout.selectPanel('dogo-workspace'),
                style: {
                  border: '1px solid var(--dsw-alias-border-subtle,#e7e9ee)',
                  borderRadius: 7,
                  background: 'transparent',
                  padding: '5px 8px',
                  fontSize: 11,
                  cursor: 'pointer',
                },
              },
              '知识工作区',
            ),
        ),
      );
    }
    return { apply, inject: ['connection', 'slots', 'layout', 'sessions', 'conversation'] };
  },
});
