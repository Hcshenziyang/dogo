import { minimalSetup } from 'codemirror';
import { markdown, markdownKeymap, markdownLanguage } from '@codemirror/lang-markdown';
import { isolateHistory } from '@codemirror/commands';
import { syntaxTree } from '@codemirror/language';
import {
  Compartment,
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
    image.src = this.src;
    image.loading = 'lazy';
    image.addEventListener('load', () => view.requestMeasure());
    image.addEventListener('click', () => {
      view.dispatch({ selection: { anchor: this.from } });
      view.focus();
    });
    return image;
  }
  ignoreEvent() {
    return true;
  }
}

class MarkdownTable extends WidgetType {
  constructor(
    readonly rows: string[][],
    readonly from: number,
  ) {
    super();
  }
  eq(other: MarkdownTable) {
    return this.from === other.from && JSON.stringify(this.rows) === JSON.stringify(other.rows);
  }
  toDOM(view: EditorView) {
    const wrapper = document.createElement('div');
    wrapper.className = 'dw-md-table-wrap';
    const table = document.createElement('table');
    table.className = 'dw-md-table';
    this.rows.forEach((row, index) => {
      const tr = document.createElement('tr');
      for (const value of row) {
        const cell = document.createElement(index === 0 ? 'th' : 'td');
        cell.textContent = value;
        tr.appendChild(cell);
      }
      table.appendChild(tr);
    });
    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'dw-md-table-edit';
    edit.textContent = '编辑表格';
    edit.addEventListener('click', () => {
      view.dispatch({ selection: { anchor: this.from } });
      view.focus();
    });
    wrapper.append(table, edit);
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
      ].map((row) =>
        row.getChildren('TableCell').map((cell) => state.sliceDoc(cell.from, cell.to)),
      );
      if (rows.length) {
        decorations.push(
          Decoration.replace({ block: true, widget: new MarkdownTable(rows, node.from) }).range(
            node.from,
            node.to,
          ),
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
const livePreview = ViewPlugin.fromClass(
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
      for (const visible of view.visibleRanges) {
        syntaxTree(state).iterate({
          from: visible.from,
          to: visible.to,
          enter(node) {
            const name = node.name;
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
              decorations.push(Decoration.mark({ class: classes[name] }).range(node.from, node.to));
            if (name === 'Image' && !activeLine(node.from)) {
              const url = node.node.getChild('URL');
              const src = url && state.sliceDoc(url.from, url.to);
              if (src && /^https?:\/\//i.test(src)) {
                const label = state.sliceDoc(node.from, node.to).match(/^!\[([^\]]*)\]/)?.[1] || '';
                decorations.push(
                  Decoration.replace({ widget: new MarkdownImage(src, label, node.from) }).range(
                    node.from,
                    node.to,
                  ),
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
              !activeLine(node.from)
            ) {
              decorations.push(Decoration.replace({}).range(node.from, node.to));
            } else if (name === 'Link' && !activeLine(node.from)) {
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

/** React is provided by the Harness host, never bundled a second time. */
export function createMarkdownEditor(React: any) {
  return function MarkdownEditor({ value, source, onChange, onBlur, onReady }: any) {
    const element = React.useRef(null as HTMLElement | null);
    const editor = React.useRef(null as EditorView | null);
    const callbacks = React.useRef({ onChange, onBlur, onReady });
    const applying = React.useRef(false);
    const mode = React.useRef(new Compartment());
    const lineEnding = React.useRef(
      value.includes('\r\n') && !/(^|[^\r])\n/.test(value) ? '\r\n' : '\n',
    );
    callbacks.current = { onChange, onBlur, onReady };
    React.useEffect(() => {
      if (!element.current) return;
      const view = new EditorView({
        parent: element.current,
        state: EditorState.create({
          doc: value.replace(/\r\n/g, '\n'),
          extensions: [
            minimalSetup,
            EditorState.lineSeparator.of('\n'),
            Prec.high(keymap.of(markdownKeymap)),
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
                    livePreview,
                    EditorView.focusChangeEffect.of((_state, focused) => focusChange.of(focused)),
                  ],
            ),
          ],
        }),
      });
      editor.current = view;
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
                livePreview,
                EditorView.focusChangeEffect.of((_state, focused) => focusChange.of(focused)),
              ],
        ),
      });
    }, [source]);
    return React.createElement('div', { className: 'dw-editor', ref: element });
  };
}
