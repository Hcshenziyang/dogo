import { minimalSetup } from 'codemirror';
import { autocompletion, type CompletionContext } from '@codemirror/autocomplete';
import { markdownRenderer, readImage, uploadImage, type WorkspaceNote } from './markdown-render.js';
import { markdown, markdownKeymap, markdownLanguage } from '@codemirror/lang-markdown';
import { isolateHistory } from '@codemirror/commands';
import { syntaxTree } from '@codemirror/language';
import {
  Compartment,
  EditorSelection,
  EditorState,
  Prec,
  StateEffect,
  StateField,
  Transaction,
} from '@codemirror/state';
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  keymap,
  type DecorationSet,
} from '@codemirror/view';

class Checkbox extends WidgetType {
  constructor(
    readonly checked: boolean,
    readonly from: number,
    readonly to: number,
  ) {
    super();
  }
  eq(other: Checkbox) {
    return this.checked === other.checked && this.from === other.from && this.to === other.to;
  }
  toDOM(view: EditorView) {
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = this.checked;
    input.className = 'dw-md-checkbox';
    input.setAttribute('aria-label', this.checked ? '标记为未完成' : '标记为已完成');
    input.addEventListener('change', () => {
      view.dispatch({
        changes: { from: this.from, to: this.to, insert: input.checked ? '[x]' : '[ ]' },
        annotations: [Transaction.userEvent.of('input'), isolateHistory.of('full')],
      });
    });
    return input;
  }
  ignoreEvent() {
    return true;
  }
}

class Bullet extends WidgetType {
  toDOM() {
    const span = document.createElement('span');
    span.className = 'dw-md-bullet';
    span.textContent = '•';
    return span;
  }
}

class MarkdownImage extends WidgetType {
  constructor(
    readonly src: string,
    readonly alt: string,
    readonly from: number,
    readonly load?: (path: string) => Promise<string>,
  ) {
    super();
  }
  eq(other: MarkdownImage) {
    return this.src === other.src && this.alt === other.alt && this.from === other.from;
  }
  toDOM(view: EditorView) {
    const image = document.createElement('img');
    image.className = 'dw-md-image';
    image.alt = this.alt;
    if (/^https?:\/\//i.test(this.src)) image.src = this.src;
    else if (this.load) {
      void this.load(this.src)
        .then((url) => {
          if (image.isConnected) {
            image.src = url;
            view.requestMeasure();
          } else URL.revokeObjectURL(url);
        })
        .catch(() => {
          image.alt = (this.alt || this.src) + '（图片不可用）';
        });
    }
    image.loading = 'lazy';
    image.addEventListener('load', () => view.requestMeasure());
    image.addEventListener('click', () => {
      view.dispatch({ selection: { anchor: this.from } });
      view.focus();
    });
    return image;
  }
  destroy(dom: HTMLElement) {
    if (dom instanceof HTMLImageElement && dom.src.startsWith('blob:'))
      URL.revokeObjectURL(dom.src);
  }
  ignoreEvent() {
    return true;
  }
}

type TableCell = { text: string; from: number; to: number };
class MarkdownTable extends WidgetType {
  constructor(
    readonly rows: TableCell[][],
    readonly from: number,
    readonly to: number,
  ) {
    super();
  }
  eq(other: MarkdownTable) {
    return (
      this.from === other.from &&
      this.to === other.to &&
      JSON.stringify(this.rows) === JSON.stringify(other.rows)
    );
  }
  toDOM(view: EditorView) {
    const wrapper = document.createElement('div');
    wrapper.className = 'dw-md-table-wrap';
    const table = document.createElement('table');
    table.className = 'dw-md-table';
    const showMenu = (rowIndex: number, columnIndex: number) => {
      wrapper.querySelector('.dw-table-menu')?.remove();
      const menu = document.createElement('div');
      menu.className = 'dw-table-menu';
      menu.setAttribute('role', 'menu');
      const action = (label: string, run: () => void, disabled = false) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = label;
        button.disabled = disabled;
        button.setAttribute('role', 'menuitem');
        button.addEventListener('click', () => {
          menu.remove();
          run();
        });
        menu.appendChild(button);
      };
      const rowLine = view.state.doc.lineAt(this.rows[rowIndex]?.[0]?.from ?? this.from);
      action('在下方插入行', () => {
        const line = rowIndex === 0 ? view.state.doc.line(rowLine.number + 1) : rowLine;
        view.dispatch({
          changes: {
            from: line.to,
            insert:
              '\n| ' +
              Array(this.rows[0]?.length || 1)
                .fill('')
                .join(' | ') +
              ' |',
          },
          annotations: isolateHistory.of('full'),
        });
      });
      action(
        '删除此行',
        () => {
          const from = rowLine.number > 1 ? rowLine.from - 1 : rowLine.from;
          view.dispatch({
            changes: { from, to: rowLine.to },
            annotations: isolateHistory.of('full'),
          });
        },
        rowIndex === 0,
      );
      const delimiterLine = view.state.doc.line(view.state.doc.lineAt(this.from).number + 1);
      const delimiters = [...delimiterLine.text.matchAll(/:?-{3,}:?/g)];
      const rectangular =
        this.rows.every((row) => row.length === delimiters.length) &&
        columnIndex < delimiters.length;
      action(
        '在右侧插入列',
        () => {
          const delimiter = delimiters[columnIndex]!;
          const changes = this.rows.map((row) => ({ from: row[columnIndex]!.to, insert: ' | ' }));
          changes.push({
            from: delimiterLine.from + delimiter.index! + delimiter[0].length,
            insert: ' | ---',
          });
          view.dispatch({ changes, annotations: isolateHistory.of('full') });
        },
        !rectangular,
      );
      action(
        '删除此列',
        () => {
          const span = (cells: { from: number; to: number }[]) =>
            columnIndex === 0
              ? { from: cells[0]!.from, to: cells[1]!.from }
              : { from: cells[columnIndex - 1]!.to, to: cells[columnIndex]!.to };
          const changes = this.rows.map(span);
          changes.push(
            span(
              delimiters.map((match) => ({
                from: delimiterLine.from + match.index!,
                to: delimiterLine.from + match.index! + match[0].length,
              })),
            ),
          );
          view.dispatch({ changes, annotations: isolateHistory.of('full') });
        },
        !rectangular || delimiters.length < 2,
      );
      action('取消', () => {});
      wrapper.appendChild(menu);
      (menu.querySelector('button:not(:disabled)') as HTMLElement | null)?.focus();
    };
    this.rows.forEach((row, rowIndex) => {
      const tr = document.createElement('tr');
      row.forEach((value, columnIndex) => {
        const cell = document.createElement(rowIndex === 0 ? 'th' : 'td');
        cell.innerHTML = markdownRenderer.renderInline(value.text.trim());
        cell.tabIndex = 0;
        cell.setAttribute('aria-label', `表格第 ${rowIndex + 1} 行第 ${columnIndex + 1} 列`);
        cell.dataset.row = String(rowIndex);
        cell.dataset.column = String(columnIndex);
        const editCell = () => {
          if (cell.querySelector('input')) return;
          const input = document.createElement('input');
          input.value = value.text.trim();
          input.setAttribute('aria-label', '编辑单元格');
          cell.replaceChildren(input);
          input.focus();
          input.select();
          let finished = false;
          const finish = (save: boolean, next?: [number, number]) => {
            if (finished) return;
            finished = true;
            if (save && input.value !== value.text.trim()) {
              const leading = value.text.match(/^\s*/)?.[0] || '';
              const trailing = value.text.match(/\s*$/)?.[0] || '';
              const text = input.value.replace(/(?<!\\)\|/g, '\\|').replace(/[\r\n]+/g, ' ');
              view.dispatch({
                changes: { from: value.from, to: value.to, insert: leading + text + trailing },
                annotations: isolateHistory.of('full'),
              });
            } else cell.innerHTML = markdownRenderer.renderInline(value.text.trim());
            if (next)
              requestAnimationFrame(() => {
                const target = view.dom.querySelector(
                  `.dw-md-table [data-row="${next[0]}"][data-column="${next[1]}"]`,
                ) as HTMLElement | null;
                target?.click();
              });
          };
          input.addEventListener('blur', () => finish(true));
          input.addEventListener('keydown', (event) => {
            event.stopPropagation();
            if (event.key === 'Escape') {
              event.preventDefault();
              finish(false);
              cell.focus();
            } else if (event.key === 'Enter') {
              event.preventDefault();
              finish(true);
              requestAnimationFrame(() => {
                (
                  view.dom.querySelector(
                    `.dw-md-table [data-row="${rowIndex}"][data-column="${columnIndex}"]`,
                  ) as HTMLElement | null
                )?.focus();
              });
            } else if (event.key === 'Tab') {
              event.preventDefault();
              let r = rowIndex,
                c = columnIndex + (event.shiftKey ? -1 : 1);
              if (c >= row.length && r + 1 < this.rows.length) {
                r++;
                c = 0;
              }
              if (c < 0 && r > 0) {
                r--;
                c = (this.rows[r]?.length || 1) - 1;
              }
              finish(true, c >= 0 && c < (this.rows[r]?.length || 0) ? [r, c] : undefined);
            }
          });
        };
        cell.addEventListener('click', editCell);
        cell.addEventListener('contextmenu', (event) => {
          event.preventDefault();
          showMenu(rowIndex, columnIndex);
        });
        cell.addEventListener('keydown', (event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            editCell();
          }
        });
        tr.appendChild(cell);
      });
      table.appendChild(tr);
    });
    const add = document.createElement('button');
    add.type = 'button';
    add.textContent = '添加行';
    add.className = 'dw-md-table-edit';
    add.addEventListener('click', () => {
      const columns = this.rows[0]?.length || 1;
      view.dispatch({
        changes: { from: this.to, insert: '\n| ' + Array(columns).fill('').join(' | ') + ' |' },
        annotations: isolateHistory.of('full'),
      });
    });
    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'dw-md-table-edit';
    edit.textContent = '编辑表格';
    edit.addEventListener('click', () => {
      view.dispatch({ selection: { anchor: this.from } });
      view.focus();
    });
    wrapper.append(table, add, edit);
    return wrapper;
  }
  ignoreEvent() {
    return true;
  }
}

function selectionIn(state: EditorState, from: number, to: number) {
  return state.selection.ranges.some((range) => range.from <= to && range.to >= from);
}
const focusChange = StateEffect.define<boolean>();
const editorFocus = StateField.define<boolean>({
  create: () => false,
  update(value, transaction) {
    for (const effect of transaction.effects) if (effect.is(focusChange)) value = effect.value;
    return value;
  },
});

// Replacing a multi-line table affects layout, so CodeMirror requires a direct
// state-field decoration rather than a viewport-only view plugin.
const tablePreview = StateField.define<DecorationSet>({
  create: tableDecorations,
  update(previous, transaction) {
    return transaction.docChanged ||
      transaction.selection ||
      syntaxTree(transaction.startState) !== syntaxTree(transaction.state) ||
      transaction.effects.some((effect) => effect.is(focusChange))
      ? tableDecorations(transaction.state)
      : previous;
  },
  provide: (field) => EditorView.decorations.from(field),
});

function tableDecorations(state: EditorState): DecorationSet {
  const decorations: any[] = [];
  syntaxTree(state).iterate({
    enter(node) {
      if (
        node.name !== 'Table' ||
        (state.field(editorFocus) && selectionIn(state, node.from, node.to))
      )
        return;
      const rows = [
        ...node.node.getChildren('TableHeader'),
        ...node.node.getChildren('TableRow'),
      ].map((row) => {
        const delimiters = row.getChildren('TableDelimiter');
        const boundaries = delimiters.map((delimiter) => ({
          from: delimiter.from,
          to: delimiter.to,
        }));
        if (!boundaries.length || boundaries[0]!.from !== row.from)
          boundaries.unshift({ from: row.from, to: row.from });
        if (boundaries[boundaries.length - 1]!.to !== row.to)
          boundaries.push({ from: row.to, to: row.to });
        return boundaries.slice(0, -1).map((boundary, index) => {
          const start = boundary.to;
          const end = boundaries[index + 1]!.from;
          const raw = state.sliceDoc(start, end);
          const leading = raw.match(/^\s*/)?.[0].length || 0;
          const trimmed = raw.trim();
          const from = start + (trimmed ? leading : Math.min(leading, 1));
          return { text: trimmed, from, to: from + trimmed.length };
        });
      });
      if (rows.length) {
        decorations.push(
          Decoration.replace({
            block: true,
            widget: new MarkdownTable(rows, node.from, node.to),
          }).range(node.from, node.to),
        );
        return false;
      }
    },
  });
  return Decoration.set(decorations, true);
}

const classes: Record<string, string> = {
  StrongEmphasis: 'dw-md-strong',
  Emphasis: 'dw-md-emphasis',
  Strikethrough: 'dw-md-strike',
  InlineCode: 'dw-md-inline-code',
  Link: 'dw-md-link',
};

// Keep Markdown itself as the editor state; decorations only change its display.
function livePreview(callbacks: { current: any }) {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = this.build(view);
      }
      update(update: any) {
        if (
          update.docChanged ||
          update.viewportChanged ||
          update.selectionSet ||
          update.focusChanged ||
          syntaxTree(update.startState) !== syntaxTree(update.state)
        )
          this.decorations = this.build(update.view);
      }
      build(view: EditorView): DecorationSet {
        const decorations: any[] = [];
        const state = view.state;
        const activeLine = (from: number) => {
          if (!view.hasFocus) return false;
          const line = state.doc.lineAt(from);
          return state.selection.ranges.some(
            (range) => range.from <= line.to && range.to >= line.from,
          );
        };
        const activeNode = (from: number, to: number) =>
          view.hasFocus && selectionIn(state, from, to);
        for (const visible of view.visibleRanges) {
          const wikiRanges: { from: number; to: number }[] = [];
          const fragment = state.sliceDoc(visible.from, visible.to);
          for (const match of fragment.matchAll(/(!?)\[\[([^\]\n]+)\]\]/g)) {
            const from = visible.from + match.index!,
              to = from + match[0].length;
            const path = match[2]!.split('|', 2)[0]!.trim();
            const label = match[2]!.split('|', 2)[1] || path;
            if (!path || activeNode(from, to)) continue;
            let parent = syntaxTree(state).resolveInner(from, 1);
            let code = false;
            while (parent) {
              if (['InlineCode', 'CodeText', 'FencedCode', 'CodeBlock'].includes(parent.name)) {
                code = true;
                break;
              }
              if (!parent.parent) break;
              parent = parent.parent;
            }
            if (code) continue;
            wikiRanges.push({ from, to });
            if (match[1])
              decorations.push(
                Decoration.replace({
                  widget: new MarkdownImage(path, label, from, (src) =>
                    readImage(callbacks.current.control, src),
                  ),
                }).range(from, to),
              );
            else
              decorations.push(
                Decoration.replace({
                  widget: new WikiLink(path, label, () => callbacks.current.onWiki(path)),
                }).range(from, to),
              );
          }
          syntaxTree(state).iterate({
            from: visible.from,
            to: visible.to,
            enter(node) {
              const name = node.name;
              if (wikiRanges.some((range) => node.from >= range.from && node.to <= range.to))
                return false;
              if (name === 'Table' && !(view.hasFocus && selectionIn(state, node.from, node.to)))
                return false;
              const heading = name.match(/^ATXHeading([1-6])$/);
              if (heading) {
                const line = state.doc.lineAt(node.from);
                decorations.push(
                  Decoration.line({ class: 'dw-md-heading dw-md-h' + heading[1] }).range(line.from),
                );
              }
              if (classes[name])
                decorations.push(
                  Decoration.mark({ class: classes[name] }).range(node.from, node.to),
                );
              if (name === 'Image' && !activeNode(node.from, node.to)) {
                const url = node.node.getChild('URL');
                const src = url && state.sliceDoc(url.from, url.to);
                if (src && (/^https?:\/\//i.test(src) || !/^(?:[a-z][a-z\d+.-]*:|\/)/i.test(src))) {
                  const label =
                    state.sliceDoc(node.from, node.to).match(/^!\[([^\]]*)\]/)?.[1] || '';
                  decorations.push(
                    Decoration.replace({
                      widget: new MarkdownImage(src, label, node.from, (path) =>
                        readImage(callbacks.current.control, path),
                      ),
                    }).range(node.from, node.to),
                  );
                  return false;
                }
              } else if (name === 'TaskMarker') {
                const checked = /[xX]/.test(state.sliceDoc(node.from, node.to));
                decorations.push(
                  Decoration.replace({ widget: new Checkbox(checked, node.from, node.to) }).range(
                    node.from,
                    node.to,
                  ),
                );
              } else if (name === 'ListMark' && !activeLine(node.from)) {
                const text = state.sliceDoc(node.from, node.to);
                if (/^[-*+]$/.test(text)) {
                  const task = node.node.parent?.getChild('Task');
                  decorations.push(
                    Decoration.replace(task ? {} : { widget: new Bullet() }).range(
                      node.from,
                      node.to,
                    ),
                  );
                }
              } else if (name === 'HeaderMark' && !activeLine(node.from)) {
                const after = state.sliceDoc(node.to, Math.min(node.to + 1, state.doc.length));
                decorations.push(
                  Decoration.replace({}).range(node.from, node.to + (after === ' ' ? 1 : 0)),
                );
              } else if (
                ['EmphasisMark', 'StrikethroughMark', 'CodeMark'].includes(name) &&
                node.node.parent?.name !== 'FencedCode' &&
                !activeNode(node.node.parent?.from ?? node.from, node.node.parent?.to ?? node.to)
              ) {
                decorations.push(Decoration.replace({}).range(node.from, node.to));
              } else if (name === 'Link' && !activeNode(node.from, node.to)) {
                const marks = node.node.getChildren('LinkMark');
                if (marks.length >= 2) {
                  decorations.push(Decoration.replace({}).range(marks[0].from, marks[0].to));
                  decorations.push(Decoration.replace({}).range(marks[1].from, node.to));
                }
              }
            },
          });
        }
        return Decoration.set(decorations, true);
      }
    },
    { decorations: (plugin) => plugin.decorations },
  );
}

class WikiLink extends WidgetType {
  constructor(
    readonly target: string,
    readonly label: string,
    readonly open: () => void,
  ) {
    super();
  }
  eq(other: WikiLink) {
    return this.target === other.target && this.label === other.label;
  }
  toDOM() {
    const link = document.createElement('a');
    link.className = 'dw-wiki-link';
    link.textContent = this.label;
    link.href = '#';
    link.addEventListener('click', (event) => {
      event.preventDefault();
      if (event.metaKey || event.ctrlKey) this.open();
    });
    return link;
  }
  ignoreEvent() {
    return true;
  }
}

function toggleMark(mark: string) {
  return (view: EditorView) => {
    const changes = view.state.changeByRange((range) => {
      const selected = view.state.sliceDoc(range.from, range.to);
      const before = view.state.sliceDoc(Math.max(0, range.from - mark.length), range.from);
      const after = view.state.sliceDoc(range.to, range.to + mark.length);
      if (before === mark && after === mark) {
        return {
          changes: [
            { from: range.from - mark.length, to: range.from },
            { from: range.to, to: range.to + mark.length },
          ],
          range: EditorSelection.range(range.from - mark.length, range.to - mark.length),
        };
      }
      if (
        selected.startsWith(mark) &&
        selected.endsWith(mark) &&
        selected.length >= mark.length * 2
      ) {
        return {
          changes: [
            { from: range.from, to: range.from + mark.length },
            { from: range.to - mark.length, to: range.to },
          ],
          range: EditorSelection.range(range.from, range.to - mark.length * 2),
        };
      }
      if (range.empty)
        return {
          changes: { from: range.from, insert: mark + mark },
          range: EditorSelection.cursor(range.from + mark.length),
        };
      return {
        changes: [
          { from: range.from, insert: mark },
          { from: range.to, insert: mark },
        ],
        range: EditorSelection.range(range.from + mark.length, range.to + mark.length),
      };
    });
    view.dispatch({
      ...changes,
      annotations: isolateHistory.of('full'),
      userEvent: 'input.format',
    });
    return true;
  };
}

/** React is provided by the Harness host, never bundled a second time. */
export function createMarkdownEditor(React: any) {
  return function MarkdownEditor({
    value,
    source,
    onChange,
    onBlur,
    onReady,
    notes,
    control,
    onWiki,
    onExternal,
    onError,
    onUpload,
    restore,
  }: any) {
    const element = React.useRef(null as HTMLElement | null);
    const editor = React.useRef(null as EditorView | null);
    const callbacks = React.useRef({
      onChange,
      onBlur,
      onReady,
      notes,
      control,
      onWiki,
      onExternal,
      onError,
      onUpload,
    });
    const applying = React.useRef(false);
    const mode = React.useRef(new Compartment());
    const lineEnding = React.useRef(
      value.includes('\r\n') && !/(^|[^\r])\n/.test(value) ? '\r\n' : '\n',
    );
    callbacks.current = {
      onChange,
      onBlur,
      onReady,
      notes,
      control,
      onWiki,
      onExternal,
      onError,
      onUpload,
    };
    React.useEffect(() => {
      if (!element.current) return;
      const view = new EditorView({
        parent: element.current,
        state: EditorState.create({
          doc: value.replace(/\r\n/g, '\n'),
          extensions: [
            minimalSetup,
            EditorState.lineSeparator.of('\n'),
            Prec.high(
              keymap.of([
                { key: 'Mod-b', run: toggleMark('**') },
                { key: 'Mod-i', run: toggleMark('*') },
                ...markdownKeymap,
              ]),
            ),
            autocompletion({
              override: [
                (context: CompletionContext) => {
                  const match = context.matchBefore(/\[\[[^\]\n|#]*/);
                  if (!match) return null;
                  const query = match.text.slice(2).toLowerCase();
                  const options = (callbacks.current.notes as WorkspaceNote[])
                    .filter(
                      (note) =>
                        note.kind === 'note' &&
                        (note.title.toLowerCase().includes(query) ||
                          note.id.toLowerCase().includes(query)),
                    )
                    .map((note) => ({
                      label: note.title,
                      detail: note.id,
                      apply: note.id.replace(/\.md$/i, '') + ']]',
                      type: 'text',
                    }));
                  return { from: match.from + 2, options, filter: false };
                },
              ],
            }),
            EditorView.domEventHandlers({
              paste(event, view) {
                const file = Array.from(event.clipboardData?.files || []).find((item) =>
                  item.type.startsWith('image/'),
                );
                if (!file) return false;
                event.preventDefault();
                const marker = `![正在保存图片](dogo-upload-${crypto.randomUUID()})`;
                view.dispatch(view.state.replaceSelection(marker));
                const upload = uploadImage(callbacks.current.control, file)
                  .then((path) => {
                    const text = view.state.doc.toString(),
                      index = text.indexOf(marker);
                    if (index >= 0)
                      view.dispatch({
                        changes: {
                          from: index,
                          to: index + marker.length,
                          insert: `![图片](${path})`,
                        },
                        annotations: isolateHistory.of('full'),
                      });
                  })
                  .catch((error) => {
                    const text = view.state.doc.toString(),
                      index = text.indexOf(marker);
                    if (index >= 0)
                      view.dispatch({
                        changes: { from: index, to: index + marker.length, insert: '' },
                      });
                    callbacks.current.onError(error);
                  });
                callbacks.current.onUpload(upload);
                return true;
              },
              mousedown(event, view) {
                if (!(event.metaKey || event.ctrlKey) || event.button !== 0) return false;
                const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
                if (pos === null) return false;
                let node = syntaxTree(view.state).resolveInner(pos, 1);
                while (node && node.name !== 'Link' && node.parent) node = node.parent;
                if (node.name !== 'Link') return false;
                const url = node.getChild('URL');
                const href = url && view.state.sliceDoc(url.from, url.to);
                if (href && /^https?:\/\//i.test(href)) {
                  event.preventDefault();
                  callbacks.current.onExternal(href);
                  return true;
                }
                return false;
              },
            }),
            markdown({ base: markdownLanguage }),
            EditorView.lineWrapping,
            EditorView.contentAttributes.of({ 'aria-label': '笔记正文', spellcheck: 'false' }),
            EditorView.updateListener.of((update) => {
              if (update.docChanged && !applying.current)
                callbacks.current.onChange(
                  update.state.sliceDoc().replace(/\n/g, lineEnding.current),
                );
            }),
            mode.current.of(
              source
                ? []
                : [
                    editorFocus,
                    tablePreview,
                    livePreview(callbacks),
                    EditorView.focusChangeEffect.of((_state, focused) => focusChange.of(focused)),
                  ],
            ),
          ],
        }),
      });
      editor.current = view;
      if (restore) {
        const anchor = Math.min(restore.anchor, view.state.doc.length);
        const head = Math.min(restore.head, view.state.doc.length);
        view.dispatch({ selection: { anchor, head } });
        requestAnimationFrame(() => {
          view.scrollDOM.scrollTop = restore.scrollTop || 0;
        });
      }
      callbacks.current.onReady(view);
      const blur = () => callbacks.current.onBlur();
      view.contentDOM.addEventListener('blur', blur);
      return () => {
        view.contentDOM.removeEventListener('blur', blur);
        callbacks.current.onReady(null);
        editor.current = null;
        view.destroy();
      };
    }, []);
    React.useEffect(() => {
      const view = editor.current;
      lineEnding.current = value.includes('\r\n') && !/(^|[^\r])\n/.test(value) ? '\r\n' : '\n';
      const normalized = value.replace(/\r\n/g, '\n');
      if (!view || view.state.sliceDoc() === normalized) return;
      applying.current = true;
      try {
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: normalized },
          annotations: Transaction.addToHistory.of(false),
        });
      } finally {
        applying.current = false;
      }
    }, [value]);
    React.useEffect(() => {
      editor.current?.dispatch({
        effects: mode.current.reconfigure(
          source
            ? []
            : [
                editorFocus,
                tablePreview,
                livePreview(callbacks),
                EditorView.focusChangeEffect.of((_state, focused) => focusChange.of(focused)),
              ],
        ),
      });
    }, [source]);
    return React.createElement('div', { className: 'dw-editor', ref: element });
  };
}
