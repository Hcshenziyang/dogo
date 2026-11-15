import { markdownRenderer, readImage } from './markdown-render.js';

type Dict = Record<string, any>;
type View = { x: number; y: number; scale: number };
type Position = { id: string; x: number; y: number; width: number; height: number };
type Selection = { nodes: string[]; edge: string | null };
const MIN_SCALE = 0.025;
const MAX_SCALE = 3;
const DRAG_TYPE = 'application/x-dogo-workspace-note';
const colors: Record<string, string> = {
  '1': '#d55b58',
  '2': '#db924a',
  '3': '#c2a036',
  '4': '#589b6b',
  '5': '#4d9eaa',
  '6': '#8d73c0',
};
function color(value: unknown, fallback: string) {
  if (typeof value !== 'string') return fallback;
  return colors[value] || (/^#[0-9a-f]{6}$/i.test(value) ? value : fallback);
}
function sidePoint(node: Dict, side: string | undefined, fallback: string) {
  switch (side || fallback) {
    case 'top':
      return { x: node.x + node.width / 2, y: node.y };
    case 'right':
      return { x: node.x + node.width, y: node.y + node.height / 2 };
    case 'left':
      return { x: node.x, y: node.y + node.height / 2 };
    default:
      return { x: node.x + node.width / 2, y: node.y + node.height };
  }
}
function edgePath(
  a: { x: number; y: number },
  b: { x: number; y: number },
  from: string,
  to: string,
) {
  const vectors: Record<string, [number, number]> = {
    top: [0, -1],
    right: [1, 0],
    bottom: [0, 1],
    left: [-1, 0],
  };
  const distance = Math.max(40, Math.min(300, Math.hypot(b.x - a.x, b.y - a.y) * 0.45));
  const [ax, ay] = vectors[from] || vectors.bottom!;
  const [bx, by] = vectors[to] || vectors.top!;
  return `M ${a.x} ${a.y} C ${a.x + ax * distance} ${a.y + ay * distance}, ${b.x + bx * distance} ${b.y + by * distance}, ${b.x} ${b.y}`;
}
function resized(node: Position | Dict, side: string, dx: number, dy: number) {
  const right = node.x + node.width,
    bottom = node.y + node.height;
  const x = side.includes('left') ? Math.min(node.x + dx, right - 80) : node.x;
  const y = side.includes('top') ? Math.min(node.y + dy, bottom - 50) : node.y;
  const width = side.includes('left')
    ? right - x
    : side.includes('right')
      ? Math.max(80, node.width + dx)
      : node.width;
  const height = side.includes('top')
    ? bottom - y
    : side.includes('bottom')
      ? Math.max(50, node.height + dy)
      : node.height;
  return { x, y, width, height };
}
function edgeMidpoint(
  a: { x: number; y: number },
  b: { x: number; y: number },
  from: string,
  to: string,
) {
  const vectors: Record<string, [number, number]> = {
    top: [0, -1],
    right: [1, 0],
    bottom: [0, 1],
    left: [-1, 0],
  };
  const [ax, ay] = vectors[from] || vectors.bottom!;
  const [bx, by] = vectors[to] || vectors.top!;
  const distance = Math.max(40, Math.min(300, Math.hypot(b.x - a.x, b.y - a.y) * 0.45));
  return {
    x: (a.x + b.x) / 2 + ((ax + bx) * distance * 3) / 8,
    y: (a.y + b.y) / 2 + ((ay + by) * distance * 3) / 8,
  };
}
function readCanvas(text: string): { nodes: Dict[]; edges: Dict[]; [key: string]: any } {
  const value = JSON.parse(text);
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    (value.nodes !== undefined && !Array.isArray(value.nodes)) ||
    (value.edges !== undefined && !Array.isArray(value.edges))
  )
    throw Error('画布格式不正确。');
  return { ...value, nodes: value.nodes || [], edges: value.edges || [] };
}
function isEditable(target: EventTarget | null) {
  return (
    target instanceof Element && !!target.closest('input,textarea,select,[contenteditable="true"]')
  );
}
const emptySelection = (): Selection => ({ nodes: [], edge: null });
const makeId = () => globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2);

export function createCanvasEditor(React: any) {
  const h = React.createElement;
  function CanvasImage({ path, control }: any) {
    const [src, setSrc] = React.useState('');
    React.useEffect(() => {
      let alive = true,
        url = '';
      setSrc('');
      void readImage(control, path)
        .then((value) => {
          if (!alive) {
            URL.revokeObjectURL(value);
            return;
          }
          url = value;
          setSrc(value);
        })
        .catch(() => {
          if (alive) setSrc('');
        });
      return () => {
        alive = false;
        if (url) URL.revokeObjectURL(url);
      };
    }, [path, control]);
    return src
      ? h('img', { src, alt: path, draggable: false, className: 'dw-canvas-image' })
      : h('span', { className: 'dw-canvas-missing' }, path || '未指定文件');
  }
  function CanvasNote({ path, control }: any) {
    const [content, setContent] = React.useState(null as string | null);
    React.useEffect(() => {
      let alive = true;
      setContent(null);
      const timer = setTimeout(() => {
        void control('get', { id: path })
          .then((doc: Dict) => {
            if (alive) setContent(doc.content);
          })
          .catch(() => {
            if (alive) setContent('');
          });
      }, 150);
      return () => {
        alive = false;
        clearTimeout(timer);
      };
    }, [path, control]);
    const html = React.useMemo(() => markdownRenderer.render(content || ''), [content]);
    const container = React.useRef(null as HTMLDivElement | null);
    React.useEffect(() => {
      let alive = true;
      const urls: string[] = [];
      for (const image of Array.from(
        container.current?.querySelectorAll('img[data-image-path]') || [],
      ) as HTMLImageElement[]) {
        const imagePath = image.dataset.imagePath;
        if (!imagePath) continue;
        void readImage(
          (method, payload = {}) => control(method, { ...payload, documentId: path }),
          imagePath,
        )
          .then((url) => {
            if (!alive) {
              URL.revokeObjectURL(url);
              return;
            }
            urls.push(url);
            image.src = url;
          })
          .catch(() => {
            image.alt = (image.alt || imagePath) + '（图片不可用）';
          });
      }
      return () => {
        alive = false;
        urls.forEach((url) => URL.revokeObjectURL(url));
      };
    }, [html, path, control]);
    return h('div', {
      ref: container,
      className: 'dw-canvas-markdown dw-canvas-note-preview',
      'aria-label': '画布笔记预览',
      onClick: (event: any) => {
        if ((event.target as Element).closest('a')) event.preventDefault();
      },
      dangerouslySetInnerHTML: {
        __html: content === null ? '加载中…' : html || '无法读取笔记或笔记为空',
      },
    });
  }
  function Node({
    node,
    index,
    selected,
    startEditing,
    uiScale,
    connecting,
    delta,
    handlers,
    control,
    vaultControl,
    onOpenNote,
  }: any) {
    const [editing, setEditing] = React.useState(!!startEditing);
    const editor = React.useRef(null as HTMLTextAreaElement | null);
    React.useEffect(() => {
      if (editing) {
        editor.current?.focus();
        if (startEditing) handlers.current.startedEditing(node.id);
      }
    }, [editing]);
    const html = React.useMemo(
      () => (node.type === 'text' ? markdownRenderer.render(node.text || '') : ''),
      [node.type, node.text],
    );
    const isGroup = node.type === 'group';
    const background = color(node.color, isGroup ? '#7890a5' : '#dbe3f0');
    const style: Dict = {
      left: node.x + (delta?.x || 0),
      top: node.y + (delta?.y || 0),
      width: Math.max(80, node.width + (delta?.width || 0)),
      height: Math.max(50, node.height + (delta?.height || 0)),
      zIndex: isGroup ? 0 : index + 2,
      borderColor: background,
    };
    if (selected) style['--dw-inverse'] = 1 / uiScale;
    if (isGroup) style.backgroundColor = background + '22';
    const change = (field: string, value: string) => handlers.current.update(node.id, field, value);
    return h(
      'div',
      {
        className:
          'dw-canvas-node ' +
          (isGroup ? 'group ' : '') +
          (selected ? 'selected ' : '') +
          (connecting ? 'connecting' : ''),
        style,
        'data-node-id': node.id,
        'data-node-type': node.type,
        onPointerDown: (event: any) => handlers.current.drag(event, node),
      },
      h(
        'div',
        { className: 'dw-canvas-node-head', title: '拖动节点' },
        h(
          'span',
          null,
          { text: '文本', group: '分组', file: '文件', link: '链接' }[node.type as string] ||
            node.type,
        ),
        isGroup &&
          h('input', {
            value: node.label || '',
            placeholder: '分组名称',
            'aria-label': '分组名称',
            onChange: (e: any) => change('label', e.target.value),
          }),
      ),
      node.type === 'text' &&
        (editing
          ? h('textarea', {
              ref: editor,
              value: node.text || '',
              'aria-label': '画布卡片文字',
              onChange: (e: any) => change('text', e.target.value),
              onBlur: () => setEditing(false),
              onKeyDown: (e: any) => {
                if (e.key === 'Escape') {
                  e.preventDefault();
                  e.stopPropagation();
                  setEditing(false);
                  handlers.current.focusCanvas();
                }
              },
            })
          : h('div', {
              className: 'dw-canvas-markdown',
              title: '双击编辑',
              style: {
                textAlign: ['left', 'right', 'center'].includes(node.styleAttributes?.textAlign)
                  ? node.styleAttributes.textAlign
                  : undefined,
              },
              onDoubleClick: (event: any) => {
                event.preventDefault();
                event.stopPropagation();
                setEditing(true);
              },
              onClick: (event: any) => {
                if ((event.target as Element).closest('a')) event.preventDefault();
              },
              dangerouslySetInnerHTML: { __html: html },
            })),
      node.type === 'file' &&
        h(
          React.Fragment,
          null,
          /\.(png|jpe?g|gif|webp)$/i.test(node.file || '') &&
            h(CanvasImage, { path: node.file, control }),
          /\.md$/i.test(node.file || '') &&
            h(CanvasNote, { path: node.file, control: vaultControl }),
          h('input', {
            value: node.file || '',
            placeholder: '知识库内文件路径',
            'aria-label': '画布文件路径',
            onChange: (e: any) => change('file', e.target.value),
          }),
          /\.md$/i.test(node.file || '') &&
            h(
              'button',
              {
                type: 'button',
                onClick: (e: any) => {
                  e.stopPropagation();
                  onOpenNote(node.file);
                },
              },
              '打开笔记',
            ),
        ),
      node.type === 'link' &&
        h('input', {
          value: node.url || '',
          placeholder: 'https://',
          'aria-label': '画布链接地址',
          onChange: (e: any) => change('url', e.target.value),
        }),
      !['text', 'file', 'link', 'group'].includes(node.type) &&
        h('span', null, '此类型的内容暂不可编辑'),
      selected &&
        h(
          React.Fragment,
          null,
          ...['top', 'right', 'bottom', 'left'].map((side) =>
            h('button', {
              key: side,
              type: 'button',
              className: 'dw-canvas-port ' + side,
              'aria-label':
                '从节点' + { top: '上', right: '右', bottom: '下', left: '左' }[side] + '侧连线',
              onPointerDown: (event: any) => handlers.current.connect(event, node, side),
            }),
          ),
          ...[
            'top',
            'right',
            'bottom',
            'left',
            'top-left',
            'top-right',
            'bottom-left',
            'bottom-right',
          ].map((side) =>
            h('button', {
              key: 'resize-' + side,
              type: 'button',
              className: 'dw-canvas-resize ' + (side.includes('-') ? 'corner ' : 'edge ') + side,
              'aria-label':
                side === 'bottom-right'
                  ? '调整节点大小'
                  : '调整节点大小：' +
                    {
                      top: '上',
                      right: '右',
                      bottom: '下',
                      left: '左',
                      'top-left': '左上',
                      'top-right': '右上',
                      'bottom-left': '左下',
                    }[side],
              tabIndex: side === 'bottom-right' ? 0 : -1,
              onPointerDown: (e: any) => handlers.current.resize(e, node, side),
              onKeyDown: (e: any) => handlers.current.resizeKey(e, node, side),
            }),
          ),
        ),
    );
  }
  const MemoNode = React.memo(Node);
  return function CanvasEditor({
    doc,
    onChange,
    control,
    vaultControl,
    documents,
    views,
    onOpenNote,
    onError,
  }: any) {
    const root = React.useRef(null as HTMLDivElement | null);
    const holder = React.useRef(null as HTMLDivElement | null);
    const initialView = React.useRef(views.get(doc.id));
    const [view, setView] = React.useState(
      () => views.get(doc.id) || ({ x: 0, y: 0, scale: 1 } as View),
    );
    const currentView = React.useRef(view);
    currentView.current = view;
    React.useEffect(() => {
      views.set(doc.id, view);
    }, [doc.id, view, views]);
    const [selection, setSelection] = React.useState(emptySelection as () => Selection);
    const [connecting, setConnecting] = React.useState(null as string | null);
    const [editingId, setEditingId] = React.useState(null as string | null);
    const [wire, setWire] = React.useState(
      null as null | { id: string; side: string; x: number; y: number },
    );
    const [box, setBox] = React.useState(
      null as null | { x: number; y: number; width: number; height: number },
    );
    const [confirmDelete, setConfirmDelete] = React.useState(false);
    const [moving, setMoving] = React.useState(
      null as null | { ids: string[]; x: number; y: number; resize: string | null },
    );
    const [space, setSpace] = React.useState(false);
    const spaceRef = React.useRef(false);
    const moveRef = React.useRef(null as any);
    const gestureCleanup = React.useRef(null as null | (() => void));
    const history = React.useRef({ undo: [] as string[], redo: [] as string[], key: '', time: 0 });
    const [, refreshHistory] = React.useState(0);
    React.useEffect(() => () => gestureCleanup.current?.(), []);
    React.useEffect(() => {
      const release = (event: KeyboardEvent) => {
        if (event.code === 'Space') {
          spaceRef.current = false;
          setSpace(false);
        }
      };
      const blur = () => {
        spaceRef.current = false;
        setSpace(false);
        gestureCleanup.current?.();
      };
      window.addEventListener('keyup', release);
      window.addEventListener('blur', blur);
      return () => {
        window.removeEventListener('keyup', release);
        window.removeEventListener('blur', blur);
      };
    }, []);
    const callbacks = React.useRef({ onChange, onError });
    callbacks.current = { onChange, onError };
    const parsed = React.useMemo(() => {
      try {
        return { value: readCanvas(doc.content), error: '' };
      } catch {
        return { value: null, error: '画布 JSON 格式不正确，无法编辑。' };
      }
    }, [doc.content]);
    const canvas = parsed.value;
    const nodes: Dict[] = (canvas?.nodes || []).filter(
      (node: any) =>
        node &&
        typeof node.id === 'string' &&
        [node.x, node.y, node.width, node.height].every(Number.isFinite),
    );
    const edges: Dict[] = (canvas?.edges || []).filter(
      (edge: any) => edge && typeof edge.id === 'string',
    );
    const sourceRef = React.useRef(doc.content);
    if (sourceRef.current !== doc.content) {
      sourceRef.current = doc.content;
      history.current = { undo: [], redo: [], key: '', time: 0 };
    }
    const historyChanged = () => refreshHistory((n: number) => n + 1);
    function mutate(change: (value: Dict) => void, key = '') {
      try {
        const value = readCanvas(sourceRef.current);
        change(value);
        const text = JSON.stringify(value, null, 2) + '\n';
        if (text === sourceRef.current) return;
        const stack = history.current,
          now = Date.now();
        if (!key || stack.key !== key || now - stack.time > 1000) {
          stack.undo.push(sourceRef.current);
          if (stack.undo.length > 100) stack.undo.shift();
        }
        stack.redo = [];
        stack.key = key;
        stack.time = now;
        sourceRef.current = text;
        callbacks.current.onChange(text);
        historyChanged();
      } catch (error) {
        callbacks.current.onError(error);
      }
    }
    function undo(redo = false) {
      const stack = history.current,
        from = redo ? stack.redo : stack.undo,
        to = redo ? stack.undo : stack.redo;
      const text = from.pop();
      if (text === undefined) return;
      to.push(sourceRef.current);
      stack.key = '';
      stack.time = 0;
      sourceRef.current = text;
      callbacks.current.onChange(text);
      setSelection(emptySelection());
      historyChanged();
    }
    const fit = (onlySelected = false) => {
      const element = holder.current;
      if (!element) return;
      const valid = onlySelected
        ? nodes.filter((node) => selection.nodes.includes(node.id))
        : nodes;
      if (!valid.length) {
        if (!onlySelected)
          setView({ x: element.clientWidth / 2 - 120, y: element.clientHeight / 2 - 60, scale: 1 });
        return;
      }
      const left = Math.min(...valid.map((n) => n.x)),
        top = Math.min(...valid.map((n) => n.y));
      const right = Math.max(...valid.map((n) => n.x + n.width)),
        bottom = Math.max(...valid.map((n) => n.y + n.height));
      const scale = Math.max(
        MIN_SCALE,
        Math.min(
          1,
          (element.clientWidth - 60) / Math.max(1, right - left),
          (element.clientHeight - 60) / Math.max(1, bottom - top),
        ),
      );
      setView({
        x: (element.clientWidth - (right - left) * scale) / 2 - left * scale,
        y: (element.clientHeight - (bottom - top) * scale) / 2 - top * scale,
        scale,
      });
    };
    const firstFit = React.useRef(false);
    React.useEffect(() => {
      if (!canvas || firstFit.current) return;
      firstFit.current = true;
      if (initialView.current) return;
      const frame = requestAnimationFrame(() => fit());
      return () => cancelAnimationFrame(frame);
    }, [doc.id, !!canvas]);
    React.useEffect(() => {
      const element = holder.current;
      if (!element) return;
      const wheel = (event: WheelEvent) => {
        if (isEditable(event.target)) return;
        const target = event.target as Element;
        if (
          !event.ctrlKey &&
          !event.metaKey &&
          !spaceRef.current &&
          target.closest('.dw-canvas-node.selected .dw-canvas-markdown')
        )
          return;
        event.preventDefault();
        setView((old: View) => {
          if (!event.ctrlKey && !event.metaKey && !spaceRef.current) {
            const horizontalWheel = event.shiftKey && !event.deltaX;
            return {
              ...old,
              x: old.x - (horizontalWheel ? event.deltaY : event.deltaX),
              y: old.y - (horizontalWheel ? 0 : event.deltaY),
            };
          }
          const rect = element.getBoundingClientRect(),
            x = event.clientX - rect.left,
            y = event.clientY - rect.top;
          const scale = Math.max(
            MIN_SCALE,
            Math.min(MAX_SCALE, old.scale * Math.exp(-event.deltaY * 0.002)),
          );
          return {
            scale,
            x: x - ((x - old.x) * scale) / old.scale,
            y: y - ((y - old.y) * scale) / old.scale,
          };
        });
      };
      element.addEventListener('wheel', wheel, { passive: false });
      return () => element.removeEventListener('wheel', wheel);
    }, []);
    function zoom(factor: number) {
      const element = holder.current;
      if (!element) return;
      setView((old: View) => {
        const scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, old.scale * factor));
        const x = element.clientWidth / 2,
          y = element.clientHeight / 2;
        return {
          scale,
          x: x - ((x - old.x) * scale) / old.scale,
          y: y - ((y - old.y) * scale) / old.scale,
        };
      });
    }
    function focusCanvas() {
      holder.current?.focus({ preventScroll: true });
    }
    function point(clientX: number, clientY: number) {
      const rect = holder.current!.getBoundingClientRect(),
        v = currentView.current;
      return { x: (clientX - rect.left - v.x) / v.scale, y: (clientY - rect.top - v.y) / v.scale };
    }
    function panOrSelect(event: any) {
      if (isEditable(event.target) || event.target.closest('button,select')) return;
      const pan = event.button === 1 || (event.button === 0 && spaceRef.current);
      if (!pan && (event.button !== 0 || event.target.closest('.dw-canvas-node,.dw-edge-hit')))
        return;
      event.preventDefault();
      focusCanvas();
      gestureCleanup.current?.();
      const start = { x: event.clientX, y: event.clientY, view: currentView.current },
        origin = point(event.clientX, event.clientY);
      const old = selection,
        additive = event.shiftKey;
      let didMove = false;
      const move = (next: PointerEvent) => {
        if (next.pointerId !== event.pointerId) return;
        didMove ||= Math.hypot(next.clientX - start.x, next.clientY - start.y) > 3;
        if (pan)
          setView({
            ...start.view,
            x: start.view.x + next.clientX - start.x,
            y: start.view.y + next.clientY - start.y,
          });
        else {
          const rect = holder.current!.getBoundingClientRect();
          setBox({
            x: Math.min(start.x, next.clientX) - rect.left,
            y: Math.min(start.y, next.clientY) - rect.top,
            width: Math.abs(next.clientX - start.x),
            height: Math.abs(next.clientY - start.y),
          });
        }
      };
      const cleanup = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', end);
        window.removeEventListener('pointercancel', cancel);
        gestureCleanup.current = null;
      };
      const end = (next: PointerEvent) => {
        if (next.pointerId !== event.pointerId) return;
        cleanup();
        setBox(null);
        if (pan) return;
        if (!didMove) {
          if (!additive) setSelection(emptySelection());
          return;
        }
        const last = point(next.clientX, next.clientY);
        const x1 = Math.min(origin.x, last.x),
          x2 = Math.max(origin.x, last.x),
          y1 = Math.min(origin.y, last.y),
          y2 = Math.max(origin.y, last.y);
        const ids = nodes
          .filter((n) =>
            n.type === 'group'
              ? n.x >= x1 && n.x + n.width <= x2 && n.y >= y1 && n.y + n.height <= y2
              : n.x < x2 && n.x + n.width > x1 && n.y < y2 && n.y + n.height > y1,
          )
          .map((n) => n.id);
        setSelection({ nodes: additive ? [...new Set([...old.nodes, ...ids])] : ids, edge: null });
      };
      const cancel = (next?: PointerEvent) => {
        if (next && next.pointerId !== event.pointerId) return;
        cleanup();
        setBox(null);
        if (pan) setView(start.view);
      };
      gestureCleanup.current = cancel;
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', end);
      window.addEventListener('pointercancel', cancel);
    }
    function connectNodes(fromNode: string, fromSide: string, toNode: string, toSide: string) {
      if (fromNode === toNode) return;
      mutate((value) => value.edges.push({ id: makeId(), fromNode, fromSide, toNode, toSide }));
    }
    function drag(event: any, node: Dict, resize: string | null = null) {
      if (event.button !== 0 || spaceRef.current) return;
      if (!resize && isEditable(event.target)) return;
      if (!resize && event.target.closest('button')) return;
      event.preventDefault();
      event.stopPropagation();
      focusCanvas();
      gestureCleanup.current?.();
      if (connecting !== null && !resize) {
        if (!connecting) setConnecting(node.id);
        else {
          connectNodes(connecting, 'right', node.id, 'left');
          setConnecting(null);
        }
        return;
      }
      let ids = selection.nodes;
      if (!resize && event.shiftKey) {
        if (ids.includes(node.id)) {
          setSelection({ nodes: ids.filter((id: string) => id !== node.id), edge: null });
          return;
        }
        ids = [...ids, node.id];
      } else if (!ids.includes(node.id)) ids = [node.id];
      if (resize) ids = [node.id];
      setSelection({ nodes: ids, edge: null });
      const selectedNodes = nodes.filter(
        (item) =>
          ids.includes(item.id) ||
          (!resize &&
            nodes.some(
              (group) =>
                ids.includes(group.id) &&
                group.type === 'group' &&
                item.x >= group.x &&
                item.y >= group.y &&
                item.x + item.width <= group.x + group.width &&
                item.y + item.height <= group.y + group.height,
            )),
      );
      const origins: Position[] = selectedNodes.map((item) => ({
        id: item.id,
        x: item.x,
        y: item.y,
        width: item.width,
        height: item.height,
      }));
      const startX = event.clientX,
        startY = event.clientY,
        scale = currentView.current.scale;
      const movedIds = origins.map((item) => item.id);
      const move = (next: PointerEvent) => {
        if (next.pointerId !== event.pointerId) return;
        const x = Math.round((next.clientX - startX) / scale),
          y = Math.round((next.clientY - startY) / scale);
        moveRef.current = { x, y };
        setMoving({ ids: movedIds, x, y, resize });
      };
      const cleanup = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', end);
        window.removeEventListener('pointercancel', cancel);
        gestureCleanup.current = null;
      };
      const end = (next: PointerEvent) => {
        if (next.pointerId !== event.pointerId) return;
        cleanup();
        const delta = moveRef.current;
        moveRef.current = null;
        setMoving(null);
        if (!delta || (!delta.x && !delta.y)) {
          if (!event.shiftKey && selection.nodes.includes(node.id) && selection.nodes.length > 1)
            setSelection({ nodes: [node.id], edge: null });
          return;
        }
        mutate((value) => {
          for (const origin of origins) {
            const item = value.nodes.find((n: Dict) => n.id === origin.id);
            if (!item) continue;
            if (resize) {
              Object.assign(item, resized(origin, resize, delta.x, delta.y));
            } else {
              item.x = origin.x + delta.x;
              item.y = origin.y + delta.y;
            }
          }
        });
      };
      const cancel = (next?: PointerEvent) => {
        if (next && next.pointerId !== event.pointerId) return;
        moveRef.current = null;
        setMoving(null);
        cleanup();
      };
      gestureCleanup.current = cancel;
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', end);
      window.addEventListener('pointercancel', cancel);
    }
    function startConnection(event: any, node: Dict, side: string) {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      focusCanvas();
      gestureCleanup.current?.();
      const move = (next: PointerEvent) => {
        if (next.pointerId === event.pointerId)
          setWire({ id: node.id, side, ...point(next.clientX, next.clientY) });
      };
      const cleanup = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', end);
        window.removeEventListener('pointercancel', cancel);
        gestureCleanup.current = null;
        setWire(null);
      };
      const end = (next: PointerEvent) => {
        if (next.pointerId !== event.pointerId) return;
        const target = document
          .elementFromPoint(next.clientX, next.clientY)
          ?.closest('.dw-canvas-node') as HTMLElement | null;
        const targetNode = nodes.find((item) => item.id === target?.dataset.nodeId);
        if (targetNode && targetNode.id !== node.id && target) {
          const r = target.getBoundingClientRect();
          const x = (next.clientX - r.left) / r.width,
            y = (next.clientY - r.top) / r.height;
          const sideDistances = [
            ['left', x],
            ['right', 1 - x],
            ['top', y],
            ['bottom', 1 - y],
          ] as [string, number][];
          sideDistances.sort((a, b) => a[1] - b[1]);
          connectNodes(node.id, side, targetNode.id, sideDistances[0]![0]);
        }
        cleanup();
      };
      const cancel = (next?: PointerEvent) => {
        if (!next || next.pointerId === event.pointerId) cleanup();
      };
      gestureCleanup.current = cancel;
      setWire({ id: node.id, side, ...sidePoint(node, side, 'right') });
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', end);
      window.addEventListener('pointercancel', cancel);
    }
    function add(type: string, at?: { x: number; y: number }, file?: string, edit = false) {
      const element = holder.current;
      if (!element || !canvas) return;
      const current = currentView.current;
      const x = Math.round((at?.x ?? (element.clientWidth / 2 - current.x) / current.scale) - 110);
      const y = Math.round((at?.y ?? (element.clientHeight / 2 - current.y) / current.scale) - 65);
      const id = makeId();
      mutate((value) =>
        value.nodes.push({
          id,
          type,
          x,
          y,
          width: type === 'group' ? 380 : 220,
          height: type === 'group' ? 240 : 130,
          ...(type === 'text'
            ? { text: edit ? '' : '新想法' }
            : type === 'group'
              ? { label: '新分组' }
              : type === 'file'
                ? { file: file || '' }
                : { url: '' }),
        }),
      );
      setSelection({ nodes: [id], edge: null });
      if (edit) setEditingId(id);
    }
    function removeSelection() {
      if (!selection.nodes.length && !selection.edge) return;
      mutate((value) => {
        if (selection.nodes.length) {
          value.nodes = value.nodes.filter((n: Dict) => !selection.nodes.includes(n.id));
          value.edges = value.edges.filter(
            (e: Dict) =>
              !selection.nodes.includes(e.fromNode) && !selection.nodes.includes(e.toNode),
          );
        } else value.edges = value.edges.filter((e: Dict) => e.id !== selection.edge);
      });
      setSelection(emptySelection());
      setConfirmDelete(false);
    }
    function keyboard(event: any) {
      if (isEditable(event.target)) return;
      if (event.code === 'Space' && !event.metaKey && !event.ctrlKey && !event.altKey) {
        event.preventDefault();
        spaceRef.current = true;
        setSpace(true);
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        event.stopPropagation();
        undo(event.shiftKey);
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'y') {
        event.preventDefault();
        event.stopPropagation();
        undo(true);
        return;
      }
      if (event.shiftKey && (event.key === '!' || event.key === '1')) {
        event.preventDefault();
        fit();
        return;
      }
      if (event.shiftKey && (event.key === '@' || event.key === '2')) {
        event.preventDefault();
        fit(true);
        return;
      }
      if (event.key === 'Escape') {
        setConnecting(null);
        setSelection(emptySelection());
        return;
      }
      if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault();
        event.stopPropagation();
        removeSelection();
      }
    }
    const deltaFor = (id: string) => {
      if (!moving?.ids.includes(id)) return undefined;
      if (!moving.resize) return { x: moving.x, y: moving.y };
      const node = nodes.find((item) => item.id === id)!;
      const next = resized(node, moving.resize, moving.x, moving.y);
      return {
        x: next.x - node.x,
        y: next.y - node.y,
        width: next.width - node.width,
        height: next.height - node.height,
      };
    };
    const displayNodes = nodes.map((node) => {
      const delta = deltaFor(node.id);
      return delta
        ? {
            ...node,
            x: node.x + (delta.x || 0),
            y: node.y + (delta.y || 0),
            width: Math.max(80, node.width + (delta.width || 0)),
            height: Math.max(50, node.height + (delta.height || 0)),
          }
        : node;
    });
    const lookup = new Map(displayNodes.map((node) => [node.id, node]));
    const selectedEdge = edges.find((edge) => edge.id === selection.edge);
    const updateEdge = (field: string, value: string) =>
      mutate(
        (data) => {
          const edge = data.edges.find((item: Dict) => item.id === selection.edge);
          if (edge) edge[field] = value;
        },
        'edge:' + selection.edge + ':' + field,
      );
    const button = (label: string, click: () => void, disabled = false, title?: string) =>
      h(
        'button',
        { type: 'button', className: 'dw-btn line', onClick: click, disabled, title },
        label,
      );
    const nodeHandlers = React.useRef(null as any);
    nodeHandlers.current = {
      drag,
      resize: (event: any, item: Dict, side: string) => drag(event, item, side),
      resizeKey: (event: any, item: Dict, side: string) => {
        const dx = event.key === 'ArrowLeft' ? -10 : event.key === 'ArrowRight' ? 10 : 0;
        const dy = event.key === 'ArrowUp' ? -10 : event.key === 'ArrowDown' ? 10 : 0;
        if (!dx && !dy) return;
        event.preventDefault();
        event.stopPropagation();
        mutate((value) => {
          const node = value.nodes.find((candidate: Dict) => candidate.id === item.id);
          if (node) Object.assign(node, resized(node, side, dx, dy));
        });
      },
      connect: startConnection,
      update: (id: string, field: string, text: string) =>
        mutate(
          (value) => {
            const item = value.nodes.find((n: Dict) => n.id === id);
            if (item) item[field] = text;
          },
          'node:' + id + ':' + field,
        ),
      focusCanvas,
      startedEditing: (id: string) =>
        setEditingId((current: string | null) => (current === id ? null : current)),
    };
    const gridSize = Math.max(10, 20 * view.scale);
    return h(
      'div',
      { ref: root, className: 'dw-canvas-editor', onKeyDown: keyboard },
      h(
        'div',
        { className: 'dw-canvas-controls' },
        button('添加文本', () => add('text'), !!parsed.error),
        button('添加分组', () => add('group'), !!parsed.error),
        button('添加文件', () => add('file'), !!parsed.error),
        button('添加链接', () => add('link'), !!parsed.error),
        button(
          connecting !== null ? '取消连线' : '连线',
          () => setConnecting(connecting === null ? '' : null),
          !!parsed.error,
        ),
        button(
          '删除选中项',
          () => setConfirmDelete(true),
          !selection.nodes.length && !selection.edge,
        ),
        button('撤销', () => undo(), !history.current.undo.length, '⌘/Ctrl+Z'),
        button('重做', () => undo(true), !history.current.redo.length, '⌘/Ctrl+Shift+Z'),
        h('span', { className: 'dw-spacer' }),
        button('缩小', () => zoom(1 / 1.3)),
        h('span', { className: 'dw-canvas-scale' }, Math.round(view.scale * 100) + '%'),
        button('放大', () => zoom(1.3)),
        button('适合画布', () => fit(), false, 'Shift+1'),
        button('适合选中', () => fit(true), !selection.nodes.length, 'Shift+2'),
      ),
      selectedEdge &&
        h(
          'div',
          { className: 'dw-canvas-edge-controls' },
          h(
            'label',
            null,
            '连线标签',
            h('input', {
              'aria-label': '连线标签',
              value: selectedEdge.label || '',
              onChange: (e: any) => updateEdge('label', e.target.value),
            }),
          ),
          h(
            'label',
            null,
            '箭头',
            h(
              'select',
              {
                'aria-label': '连线箭头',
                value:
                  (selectedEdge.fromEnd === 'arrow' ? '1' : '0') +
                  (selectedEdge.toEnd === 'none' ? '0' : '1'),
                onChange: (e: any) =>
                  mutate((value) => {
                    const edge = value.edges.find((item: Dict) => item.id === selectedEdge.id);
                    if (edge) {
                      edge.fromEnd = e.target.value[0] === '1' ? 'arrow' : 'none';
                      edge.toEnd = e.target.value[1] === '1' ? 'arrow' : 'none';
                    }
                  }),
              },
              h('option', { value: '01' }, '指向终点'),
              h('option', { value: '10' }, '指向起点'),
              h('option', { value: '11' }, '双向'),
              h('option', { value: '00' }, '无箭头'),
            ),
          ),
        ),
      parsed.error && h('div', { className: 'dw-error', role: 'alert' }, parsed.error),
      h(
        'div',
        {
          ref: holder,
          className: 'dw-canvas-holder' + (space ? ' panning' : ''),
          'aria-label': '画布',
          tabIndex: 0,
          style: {
            backgroundSize: `${gridSize}px ${gridSize}px`,
            backgroundPosition: `${view.x}px ${view.y}px`,
          },
          onPointerDown: panOrSelect,
          onDoubleClick: (event: any) => {
            if (
              connecting !== null ||
              spaceRef.current ||
              isEditable(event.target) ||
              event.target.closest('.dw-canvas-node,.dw-edge-hit,button')
            )
              return;
            event.preventDefault();
            add('text', point(event.clientX, event.clientY), undefined, true);
          },
          onDragOver: (event: any) => {
            if ([...event.dataTransfer.types].includes(DRAG_TYPE)) {
              event.preventDefault();
              event.dataTransfer.dropEffect = 'copy';
            }
          },
          onDrop: (event: any) => {
            const id = event.dataTransfer.getData(DRAG_TYPE);
            if (!documents.some((item: Dict) => item.kind === 'note' && item.id === id)) return;
            event.preventDefault();
            add('file', point(event.clientX, event.clientY), id);
            focusCanvas();
          },
        },
        h(
          'div',
          {
            className: 'dw-canvas-plane',
            style: { transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` },
          },
          h(
            'svg',
            { className: 'dw-canvas-edges', width: 1, height: 1, 'aria-label': '画布连线' },
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
                  markerWidth: 7,
                  markerHeight: 7,
                  orient: 'auto-start-reverse',
                },
                h('path', { d: 'M 0 0 L 10 5 L 0 10 z', fill: 'context-stroke' }),
              ),
            ),
            ...edges.map((edge) => {
              const a = lookup.get(edge.fromNode),
                b = lookup.get(edge.toNode);
              if (!a || !b) return null;
              const fromSide = edge.fromSide || 'bottom',
                toSide = edge.toSide || 'top';
              const start = sidePoint(a, fromSide, 'bottom'),
                end = sidePoint(b, toSide, 'top'),
                path = edgePath(start, end, fromSide, toSide),
                lineColor = color(edge.color, '#8d9bb0'),
                label = edgeMidpoint(start, end, fromSide, toSide);
              return h(
                'g',
                { key: edge.id },
                h('path', {
                  d: path,
                  fill: 'none',
                  stroke: lineColor,
                  strokeWidth: selection.edge === edge.id ? 4 : 2,
                  markerStart: edge.fromEnd === 'arrow' ? 'url(#dw-arrow)' : undefined,
                  markerEnd: edge.toEnd === 'none' ? undefined : 'url(#dw-arrow)',
                }),
                h('path', {
                  className: 'dw-edge-hit',
                  d: path,
                  fill: 'none',
                  stroke: 'transparent',
                  strokeWidth: 16 / view.scale,
                  onPointerDown: (event: any) => {
                    if (event.button !== 0 || spaceRef.current) return;
                    event.preventDefault();
                    event.stopPropagation();
                    focusCanvas();
                    setSelection({ nodes: [], edge: edge.id });
                  },
                }),
                edge.label &&
                  h(
                    'text',
                    {
                      x: label.x,
                      y: label.y,
                      fill: lineColor,
                      className: 'dw-edge-label',
                    },
                    edge.label,
                  ),
              );
            }),
            wire &&
              lookup.get(wire.id) &&
              h('path', {
                d: edgePath(
                  sidePoint(lookup.get(wire.id)!, wire.side, 'right'),
                  wire,
                  wire.side,
                  'left',
                ),
                fill: 'none',
                stroke: 'var(--dw-accent)',
                strokeWidth: 2,
                strokeDasharray: '7 5',
              }),
          ),
          ...nodes.map((node, index) =>
            h(MemoNode, {
              key: node.id,
              node,
              index,
              selected: selection.nodes.includes(node.id),
              startEditing: editingId === node.id,
              uiScale: selection.nodes.includes(node.id) ? view.scale : 1,
              connecting: connecting !== null,
              delta: deltaFor(node.id),
              handlers: nodeHandlers,
              control,
              vaultControl,
              onOpenNote,
            }),
          ),
        ),
        box &&
          h('div', {
            className: 'dw-canvas-selection-box',
            style: { left: box.x, top: box.y, width: box.width, height: box.height },
          }),
      ),
      h(
        'div',
        { className: 'dw-canvas-hint' },
        connecting !== null
          ? '依次点击起点和终点，完成连线。'
          : '拖动空白处框选；空格或中键拖动画布，滚轮平移，⌘/Ctrl 或空格 + 滚轮缩放。双击文本卡片编辑。',
      ),
      confirmDelete &&
        (selection.nodes.length > 0 || selection.edge) &&
        h(
          'div',
          { className: 'dw-overlay' },
          h(
            'section',
            {
              className: 'dw-dialog dw-dialog-compact',
              role: 'dialog',
              'aria-label': '删除画布内容',
            },
            h(
              'div',
              { className: 'dw-dialog-body' },
              selection.nodes.length ? '删除节点及其关联连线？' : '删除所选连线？',
            ),
            h(
              'div',
              { className: 'dw-dialog-foot' },
              button('取消', () => setConfirmDelete(false)),
              button('删除', removeSelection),
            ),
          ),
        ),
    );
  };
}
