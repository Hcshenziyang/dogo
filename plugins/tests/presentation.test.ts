import { describe, expect, it } from 'vitest';
import { conversation, safeLink } from '../shared/presentation.js';

describe('client data boundaries', () => {
  it('renders user and assistant text without duplicating tool-call blocks', () => {
    const record = (type: string, data: unknown) => ({ event: { type, data } });
    const result = conversation({
      records: [
        record('turn/start', {}),
        record('user/message', {
          source: { kind: 'user' },
          content: [{ type: 'text', text: '继续' }],
        }),
        record('user/message', {
          source: { kind: 'system' },
          content: [{ type: 'text', text: 'internal' }],
        }),
        record('assistant/message', {
          message: {
            content: [
              { type: 'tool-call', name: 'search' },
              { type: 'text', text: '正在查找' },
            ],
          },
        }),
        record('tool/call', { name: 'search', arguments: { q: 'example' } }),
        record('turn/end', { reason: { kind: 'cancelled' } }),
      ],
    });
    expect(result.items.map((item) => item.role)).toEqual(['user', 'assistant', 'tool']);
    expect(result.items[1].text).toBe('正在查找');
    expect(result.state).toBe('已停止');
    expect(result.running).toBe(false);
  });
  it('does not turn unsafe markup links into executable URLs', () => {
    for (const value of [
      'javascript:alert(1)',
      'data:text/html,test',
      'file:///etc/passwd',
      '/relative',
    ])
      expect(safeLink(value)).toBeUndefined();
    expect(safeLink('https://example.com/article')).toBe('https://example.com/article');
  });
  it('surfaces a native model error as an error rather than a completed reply', () => {
    const result = conversation({
      records: [
        {
          event: {
            type: 'turn/end',
            data: { reason: { kind: 'error', error: { message: 'Provider unavailable' } } },
          },
        },
      ],
    });
    expect(result.state).toBe('执行出错');
    expect(result.items[0]).toMatchObject({
      role: 'status',
      text: '执行出错：Provider unavailable',
    });
  });
});
