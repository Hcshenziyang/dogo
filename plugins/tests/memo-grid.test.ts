import { describe, expect, it } from 'vitest';
import { memoProjectTone, memoWithDraft, visibleMemos } from '../memos/presentation.js';

describe('memo grid presentation', () => {
  const memo = {
    id: 'a',
    content: '服务器标题\n正文',
    project: '项目',
    category: '旧分类',
    tags: ['标记'],
    revision: 4,
    updated_at: 20,
    created_at: 10,
    dispatch: { status: 'accepted' },
  };
  it('shows local edits without disguising the server timestamp or delivery state', () => {
    const local = {
      ...memo,
      content: '本机草稿\n新正文',
      dirty: true,
      revision: 3,
      updated_at: 1,
      dispatch: { status: 'pending' },
    };
    expect(memoWithDraft(memo, local)).toEqual({
      ...local,
      updated_at: 20,
      dispatch: memo.dispatch,
    });
    expect(memoWithDraft(memo, null)).toBe(memo);
    expect(memoWithDraft(memo, { ...local, dirty: false })).toBe(memo);
  });
  it('searches drafts, projects, categories and edited tags with trimmed queries', () => {
    const draft = memoWithDraft(memo, {
      ...memo,
      content: '本机草稿',
      tagText: '新标签',
      dirty: true,
    });
    for (const search of [' 本机草稿 ', '项目', '旧分类', '新标签', '标记'])
      expect(visibleMemos([draft], search, 'updated')).toHaveLength(1);
    expect(visibleMemos([draft], '服务器标题', 'updated')).toHaveLength(0);
  });
  it('sorts a copy by edited/created date or title without mutating records', () => {
    const a = { id: 'a', content: 'A', updated_at: 20, created_at: 5 };
    const b = { id: 'b', content: 'B', updated_at: 10, created_at: 30 };
    const list = [b, a];
    expect(visibleMemos(list, '', 'updated').map((m) => m.id)).toEqual(['a', 'b']);
    expect(visibleMemos(list, '', 'created').map((m) => m.id)).toEqual(['b', 'a']);
    expect(visibleMemos(list, '', 'title').map((m) => m.id)).toEqual(['a', 'b']);
    expect(list).toEqual([b, a]);
  });
  it('handles timestamp formats and undated new drafts', () => {
    const list = [
      { id: 'draft', content: 'new' },
      { id: 'seconds', updated_at: 100 },
      { id: 'iso', updated_at: '2026-10-30T00:00:00Z' },
    ];
    expect(visibleMemos(list, '', 'updated').map((m) => m.id)).toEqual(['iso', 'seconds', 'draft']);
  });
  it('assigns stable project colors without inventing a category or server field', () => {
    expect(memoProjectTone('')).toBe('');
    expect(memoProjectTone('项目')).toBe(memoProjectTone('项目'));
    expect(['blue', 'amber', 'green', 'purple']).toContain(memoProjectTone('中文项目'.repeat(40)));
  });
});
