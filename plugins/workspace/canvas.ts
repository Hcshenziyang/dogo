import { markdownRenderer, readImage } from './markdown-render.js';

type Dict = Record<string, any>;
type View = { x: number; y: number; scale: number };
type Position = { id: string; x: number; y: number; width: number; height: number };
const MIN_SCALE = 0.025;
const MAX_SCALE = 3;
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

export function createCanvasEditor(React: any) {
  const h = React.createElement;
  function CanvasImage({ path, control }: any) {
    const [src, setSrc] = React.useState('');
    React.useEffect(() => {
      let alive = true,
        url = '';
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
  function Node({
    node,
    index,
    selected,
    connecting,
    delta,
    onSelect,
    onDrag,
    onResize,
    update,
    control,
    onOpenNote,
  }: any) {
    const [editing, setEditing] = React.useState(false);
    const editor = React.useRef(null as HTMLTextAreaElement | null);
    React.useEffect(() => {
      if (editing) editor.current?.focus();
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
      zIndex: index + 1,
      borderColor: background,
    };
    if (isGroup) style.backgroundColor = background + '22';
    const change = (field: string, value: string) => update(node.id, field, value);
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
        onClick: (event: any) => {
          event.stopPropagation();
          onSelect(node.id);
        },
        onPointerDown: (event: any) => onDrag(event, node),
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
                event.stopPropagation();
                setEditing(true);
              },
              dangerouslySetInnerHTML: { __html: html },
            })),
      node.type === 'file' &&
        h(
          React.Fragment,
          null,
          /\.(png|jpe?g|gif|webp)$/i.test(node.file || '') &&
            h(CanvasImage, { path: node.file, control }),
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
        h('button', {
          type: 'button',
          className: 'dw-canvas-resize',
          'aria-label': '调整节点大小',
          onPointerDown: (e: any) => onResize(e, node),
        }),
    );
  }
  return function CanvasEditor({ doc, onChange, control, onOpenNote, onError }: any) {
    const holder = React.useRef(null as HTMLDivElement | null);
    const [view, setView] = React.useState({ x: 0, y: 0, scale: 1 } as View);
    const currentView = React.useRef(view);
    currentView.current = view;
    const [selection, setSelection] = React.useState(
      null as null | { kind: 'node' | 'edge'; id: string },
    );
    const [connecting, setConnecting] = React.useState(null as string | null);
    const [confirmDelete, setConfirmDelete] = React.useState(false);
    const [moving, setMoving] = React.useState(
      null as null | { ids: string[]; x: number; y: number; resize: boolean },
    );
    const moveRef = React.useRef(null as any);
    const gestureCleanup = React.useRef(null as null | (() => void));
    React.useEffect(() => () => gestureCleanup.current?.(), []);
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
      ),
      edges: Dict[] = (canvas?.edges || []).filter(
        (edge: any) => edge && typeof edge.id === 'string',
      );
    const sourceRef = React.useRef(doc.content);
    sourceRef.current = doc.content;
    function mutate(change: (value: Dict) => void) {
      try {
        const value = readCanvas(sourceRef.current);
        change(value);
        const text = JSON.stringify(value, null, 2) + '\n';
        sourceRef.current = text;
        callbacks.current.onChange(text);
      } catch (error) {
        callbacks.current.onError(error);
      }
    }
    const fit = () => {
      const element = holder.current;
      if (!element) return;
      const valid = nodes.filter((node) =>
        [node.x, node.y, node.width, node.height].every(Number.isFinite),
      );
      if (!valid.length) {
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
    const firstFit = React.useRef('');
    React.useEffect(() => {
      if (!canvas || firstFit.current === doc.id) return;
      firstFit.current = doc.id;
      const frame = requestAnimationFrame(fit);
      return () => cancelAnimationFrame(frame);
    }, [doc.id, !!canvas]);
    React.useEffect(() => {
      const element = holder.current;
      if (!element) return;
      const wheel = (event: WheelEvent) => {
        event.preventDefault();
        setView((old: View) => {
          if (!event.ctrlKey && !event.metaKey)
            return { ...old, x: old.x - event.deltaX, y: old.y - event.deltaY };
          const rect = element.getBoundingClientRect();
          const x = event.clientX - rect.left,
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
    function pan(event: any) {
      if (
        event.button !== 0 ||
        event.target.closest('.dw-canvas-node,button,input,textarea,.dw-edge-hit')
      )
        return;
      event.preventDefault();
      gestureCleanup.current?.();
      const start = { x: event.clientX, y: event.clientY, view: currentView.current };
      const move = (next: PointerEvent) =>
        setView({
          ...start.view,
          x: start.view.x + next.clientX - start.x,
          y: start.view.y + next.clientY - start.y,
        });
      const end = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', end);
        window.removeEventListener('pointercancel', end);
        gestureCleanup.current = null;
      };
      gestureCleanup.current = end;
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', end);
      window.addEventListener('pointercancel', end);
    }
    function drag(event: any, node: Dict, resize = false) {
      if (
        event.button !== 0 ||
        connecting ||
        (!resize && event.target.closest('textarea,input,button,.dw-canvas-markdown'))
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      gestureCleanup.current?.();
      setSelection({ kind: 'node', id: node.id });
      const selectedNodes =
        !resize && node.type === 'group'
          ? nodes.filter(
              (other) =>
                other.id === node.id ||
                (other.x >= node.x &&
                  other.y >= node.y &&
                  other.x + other.width <= node.x + node.width &&
                  other.y + other.height <= node.y + node.height),
            )
          : [node];
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
      const ids = origins.map((item) => item.id);
      const move = (next: PointerEvent) => {
        const x = Math.round((next.clientX - startX) / scale),
          y = Math.round((next.clientY - startY) / scale);
        moveRef.current = { x, y };
        setMoving({ ids, x, y, resize });
      };
      const end = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', end);
        window.removeEventListener('pointercancel', cancel);
        gestureCleanup.current = null;
        const delta = moveRef.current;
        moveRef.current = null;
        setMoving(null);
        if (!delta || (!delta.x && !delta.y)) return;
        mutate((value) => {
          for (const origin of origins) {
            const item = value.nodes.find((n: Dict) => n.id === origin.id);
            if (!item) continue;
            if (resize) {
              item.width = Math.max(80, origin.width + delta.x);
              item.height = Math.max(50, origin.height + delta.y);
            } else {
              item.x = origin.x + delta.x;
              item.y = origin.y + delta.y;
            }
          }
        });
      };
      const cancel = () => {
        moveRef.current = null;
        setMoving(null);
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', end);
        window.removeEventListener('pointercancel', cancel);
        gestureCleanup.current = null;
      };
      gestureCleanup.current = cancel;
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', end);
      window.addEventListener('pointercancel', cancel);
    }
    function add(type: string) {
      const element = holder.current;
      if (!element) return;
      const current = currentView.current;
      const x = Math.round((element.clientWidth / 2 - current.x) / current.scale - 100);
      const y = Math.round((element.clientHeight / 2 - current.y) / current.scale - 60);
      const id = globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2);
      mutate((value) =>
        value.nodes.push({
          id,
          type,
          x,
          y,
          width: type === 'group' ? 380 : 220,
          height: type === 'group' ? 240 : 130,
          ...(type === 'text'
            ? { text: '新想法' }
            : type === 'group'
              ? { label: '新分组' }
              : type === 'file'
                ? { file: '' }
                : { url: '' }),
        }),
      );
      setSelection({ kind: 'node', id });
    }
    function selectNode(id: string) {
      if (connecting === '') {
        setConnecting(id);
        return;
      }
      if (connecting) {
        if (connecting !== id)
          mutate((value) =>
            value.edges.push({
              id: globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2),
              fromNode: connecting,
              fromSide: 'right',
              toNode: id,
              toSide: 'left',
            }),
          );
        setConnecting(null);
        return;
      }
      setSelection({ kind: 'node', id });
    }
    const deltaFor = (id: string) =>
      !moving?.ids.includes(id)
        ? undefined
        : moving.resize
          ? { width: moving.x, height: moving.y }
          : { x: moving.x, y: moving.y };
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
    const button = (label: string, click: () => void, disabled = false) =>
      h('button', { type: 'button', className: 'dw-btn line', onClick: click, disabled }, label);
    return h(
      React.Fragment,
      null,
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
        button('删除选中项', () => setConfirmDelete(true), !selection),
        h('span', { className: 'dw-spacer' }),
        button('缩小', () => zoom(1 / 1.3)),
        h('span', { className: 'dw-canvas-scale' }, Math.round(view.scale * 100) + '%'),
        button('放大', () => zoom(1.3)),
        button('适合画布', fit),
      ),
      parsed.error ? h('div', { className: 'dw-error', role: 'alert' }, parsed.error) : null,
      h(
        'div',
        { ref: holder, className: 'dw-canvas-holder', 'aria-label': '画布', onPointerDown: pan },
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
              const start = sidePoint(a, edge.fromSide, 'bottom'),
                end = sidePoint(b, edge.toSide, 'top');
              const lineColor = color(edge.color, '#8d9bb0');
              return h(
                'g',
                { key: edge.id },
                h('line', {
                  x1: start.x,
                  y1: start.y,
                  x2: end.x,
                  y2: end.y,
                  stroke: lineColor,
                  strokeWidth: selection?.kind === 'edge' && selection.id === edge.id ? 4 : 2,
                  markerStart: edge.fromEnd === 'arrow' ? 'url(#dw-arrow)' : undefined,
                  markerEnd: edge.toEnd === 'none' ? undefined : 'url(#dw-arrow)',
                }),
                h('line', {
                  className: 'dw-edge-hit',
                  x1: start.x,
                  y1: start.y,
                  x2: end.x,
                  y2: end.y,
                  stroke: 'transparent',
                  strokeWidth: 20,
                  onClick: (event: any) => {
                    event.stopPropagation();
                    setSelection({ kind: 'edge', id: edge.id });
                  },
                }),
                edge.label &&
                  h(
                    'text',
                    {
                      x: (start.x + end.x) / 2,
                      y: (start.y + end.y) / 2,
                      fill: lineColor,
                      className: 'dw-edge-label',
                    },
                    edge.label,
                  ),
              );
            }),
          ),
          ...nodes.map((node, index) =>
            h(Node, {
              key: node.id,
              node,
              index,
              selected: selection?.kind === 'node' && selection.id === node.id,
              connecting: connecting !== null,
              delta: deltaFor(node.id),
              onSelect: selectNode,
              onDrag: drag,
              onResize: (event: any, item: Dict) => drag(event, item, true),
              update: (id: string, field: string, text: string) =>
                mutate((value) => {
                  const item = value.nodes.find((n: Dict) => n.id === id);
                  if (item) item[field] = text;
                }),
              control,
              onOpenNote,
            }),
          ),
        ),
      ),
      h(
        'div',
        { className: 'dw-canvas-hint' },
        connecting !== null
          ? '依次点击起点和终点，完成连线。'
          : '拖动空白处移动画布，滚轮平移，⌘/Ctrl + 滚轮缩放。双击文本卡片编辑。',
      ),
      confirmDelete &&
        selection &&
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
              selection.kind === 'node' ? '删除节点及其关联连线？' : '删除所选连线？',
            ),
            h(
              'div',
              { className: 'dw-dialog-foot' },
              button('取消', () => setConfirmDelete(false)),
              button('删除', () => {
                mutate((value) => {
                  if (selection.kind === 'node') {
                    value.nodes = value.nodes.filter((n: Dict) => n.id !== selection.id);
                    value.edges = value.edges.filter(
                      (e: Dict) => e.fromNode !== selection.id && e.toNode !== selection.id,
                    );
                  } else value.edges = value.edges.filter((e: Dict) => e.id !== selection.id);
                });
                setSelection(null);
                setConfirmDelete(false);
              }),
            ),
          ),
        ),
    );
  };
}
