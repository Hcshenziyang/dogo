import { memoTitle, type Dict } from '../shared/presentation.js';

export function memoWithDraft(memo: Dict, saved: Dict | null): Dict {
  if (!saved?.dirty) return memo;
  return {
    ...memo,
    ...saved,
    id: memo.id,
    updated_at: memo.updated_at,
    created_at: memo.created_at,
    dispatch: memo.dispatch,
  };
}
export function memoProjectTone(project = ''): string {
  if (!project) return '';
  const hash = Array.from(project).reduce((sum, char) => (sum * 31 + char.charCodeAt(0)) >>> 0, 0);
  return ['blue', 'amber', 'green', 'purple'][hash % 4];
}
export function visibleMemos(memos: Dict[], search: string, sort: string): Dict[] {
  const query = search.trim().toLocaleLowerCase();
  const timestamp = (value: unknown) => {
    if (typeof value === 'number') return value < 1e12 ? value * 1000 : value;
    const result = Date.parse(String(value || ''));
    return Number.isNaN(result) ? 0 : result;
  };
  return memos
    .filter((m) =>
      [m.content, m.project, m.category, m.tagText, ...(m.tags || [])]
        .join(' ')
        .toLocaleLowerCase()
        .includes(query),
    )
    .sort((a, b) =>
      sort === 'title'
        ? memoTitle(a.content).localeCompare(memoTitle(b.content), 'zh-CN')
        : timestamp(sort === 'created' ? b.created_at : b.updated_at) -
          timestamp(sort === 'created' ? a.created_at : a.updated_at),
    );
}
