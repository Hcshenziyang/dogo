export type Dict = Record<string, any>;
export type Control = (method: string, payload?: unknown) => Promise<any>;

export function memoTitle(content = ''): string {
  return (
    content
      .split('\n')
      .find((line) => line.trim())
      ?.replace(/^\s*#+\s*/, '')
      .trim() || '未命名备忘录'
  );
}
export function memoExcerpt(content = ''): string {
  return content.trim().split('\n').slice(1).join(' ').replace(/[#*`]/g, '').trim();
}
export function dateLabel(value: string | number | undefined): string {
  if (!value) return '';
  const date = new Date(typeof value === 'number' && value < 1e12 ? value * 1000 : value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}
export function draftKey(identity: string, id = 'new'): string {
  return 'dogo.editor.' + identity + '.' + id;
}
export function readLocal(key: string, fallback: any = null): any {
  try {
    return JSON.parse(localStorage.getItem(key) || 'null') ?? fallback;
  } catch {
    return fallback;
  }
}
export function writeLocal(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    throw Error('本机草稿未能保存。请先复制内容，避免离开页面后丢失。');
  }
}
export function blankMemo(): Dict {
  return {
    content: '',
    project: '',
    category: '',
    tags: [],
    active: true,
    request_id: crypto.randomUUID(),
  };
}
export const deliveryLabels: Record<string, string> = {
  pending: '等待设备接收',
  leased: '正在确认接收',
  accepted: '设备已接收',
  cancelled: '已取消',
};
export interface ChatItem {
  id: string;
  role: 'user' | 'assistant' | 'tool' | 'status';
  text: string;
  name?: string;
}
export function conversation(snapshot: Dict | null): {
  items: ChatItem[];
  state: string;
  running: boolean;
} {
  const items: ChatItem[] = [];
  let state = '已连接',
    running = false;
  for (const [index, record] of (snapshot?.records || []).entries()) {
    const event = record.event,
      data = event?.data;
    if (!event || !data) continue;
    const id = String(record.seq ?? index);
    if (event.type === 'turn/start') {
      state = '正在执行';
      running = true;
    }
    if (event.type === 'turn/end') {
      const reason = data.reason?.kind;
      state =
        (
          {
            completed: '本轮已结束',
            cancelled: '已停止',
            failed: '执行出错',
            error: '执行出错',
            interrupted: '已中断',
          } as Dict
        )[reason] || '本轮已结束';
      running = false;
      if (reason === 'error' || reason === 'failed')
        items.push({
          id: id + '-error',
          role: 'status',
          text: '执行出错：' + (data.reason?.error?.message || '请在执行电脑查看详情。'),
        });
    }
    if (event.type === 'user/message' && data.source?.kind === 'user') {
      items.push({ id, role: 'user', text: textBlocks(data.content) });
    }
    if (event.type === 'assistant/message') {
      const text = textBlocks(data.message?.content, true);
      if (text) items.push({ id, role: 'assistant', text });
    }
    if (event.type === 'tool/call')
      items.push({
        id,
        role: 'tool',
        name: data.name || '工具',
        text:
          typeof data.arguments === 'string'
            ? data.arguments
            : JSON.stringify(data.arguments ?? {}, null, 2),
      });
  }
  return { items, state, running };
}
function textBlocks(blocks: any[] = [], assistant = false) {
  return blocks
    .map((b) =>
      b.type === 'text'
        ? b.text
        : b.type === 'tool-call' || b.type === 'reasoning'
          ? ''
          : assistant
            ? ''
            : '[' + b.type + ']',
    )
    .filter(Boolean)
    .join('\n');
}

// Render links as text unless they have an explicitly safe web scheme.
export function safeLink(value: string): string | undefined {
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) ? url.href : undefined;
  } catch {
    return undefined;
  }
}
