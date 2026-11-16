import { describe, expect, it } from 'vitest';
import { deviceStatus, visibleSessions, workspaceBaseline } from '../devices/session-view.js';
import { renderDeviceMarkdown } from '../devices/markdown.js';

describe('desktop device presentation', () => {
  it('only shows sessions when archive state is verified and filters projects after hiding archives', () => {
    const sessions = ['active', 'archived', 'ungrouped'].map((sessionId) => ({ sessionId }));
    const projects = [{ workspaceId: 'p1', sessionIds: ['active', 'archived'] }];
    expect(visibleSessions(sessions, null, '', projects)).toEqual([]);
    expect(visibleSessions(sessions, ['archived'], '', projects)).toEqual([
      sessions[0],
      sessions[2],
    ]);
    expect(visibleSessions(sessions, ['archived'], 'p1', projects)).toEqual([sessions[0]]);
    expect(visibleSessions(sessions, ['archived'], '@ungrouped', projects)).toEqual([sessions[2]]);
    expect(
      visibleSessions([...sessions, { sessionId: 'archived' }], ['archived'], '', projects),
    ).toEqual([sessions[0], sessions[2]]);
  });

  it('rejects incomplete archive baselines and accepts a verified empty archive', () => {
    expect(workspaceBaseline({ items: [] })).toBeNull();
    expect(workspaceBaseline({ items: [], archivedSessionIds: ['ok', 1] })).toBeNull();
    expect(workspaceBaseline({ items: [{}], archivedSessionIds: [] })).toBeNull();
    expect(workspaceBaseline({ items: [], archivedSessionIds: [] })).toEqual({
      items: [],
      archived: [],
    });
  });

  it('does not call a registered mobile device offline', () => {
    const status = { deviceId: 'mac', consumer: { enabled: true, online: true } };
    expect(deviceStatus({ id: 'phone', kind: 'mobile', active: true, online: false }, status)).toBe(
      '已登记',
    );
    expect(deviceStatus({ id: 'phone', kind: 'mobile', active: false }, status)).toBe('已禁用');
    expect(deviceStatus({ id: 'mac', kind: 'desktop', active: true }, status)).toBe('在线');
    expect(
      deviceStatus({ id: 'other', kind: 'desktop', active: true, online: false }, status),
    ).toBe('离线');
  });
});

describe('desktop conversation Markdown', () => {
  it('renders text formatting, tables, code and read-only tasks', () => {
    const html = renderDeviceMarkdown(
      '**粗体** *斜体*\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n- [x] 已完成\n- [ ] 未完成\n\n```js\nconst x = 1\n```',
    );
    expect(html).toContain('<strong>粗体</strong>');
    expect(html).toContain('<em>斜体</em>');
    expect(html).toContain('<table>');
    expect(html).toContain('<input type="checkbox" disabled checked>');
    expect(html).toContain('<input type="checkbox" disabled>');
    expect(html).toContain('<code class="language-js">');
  });

  it('escapes HTML, blocks unsafe links and does not fetch remote images', () => {
    const html = renderDeviceMarkdown(
      '<script>alert(1)</script> [unsafe](javascript:alert(1)) [file](file:///etc/passwd) [safe](https://example.com) ![图片](https://example.com/pixel.png)',
    );
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('href="javascript:');
    expect(html).not.toContain('href="file:');
    expect(html).not.toContain('<img');
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('图片');
  });
});
