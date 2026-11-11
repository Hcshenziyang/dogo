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
    sync_status: memo.sync_status,
  };
}

export function memoSyncIndicator(memo: Dict, localFirst: boolean) {
  if (memo.sync_status === 'conflict')
    return {
      icon: 'warning',
      label: memo.dirty ? '同步冲突，草稿未保存' : '同步冲突',
      tone: 'warning',
    };
  if (memo.dirty || (localFirst && memo.sync_status !== 'synced'))
    return {
      icon: 'cloud-off',
      label: memo.dirty ? '未同步，草稿未保存' : '未同步',
      tone: 'muted',
    };
  return { icon: 'cloud', label: '已同步', tone: 'synced' };
}

export function visibleMemos(memos: Dict[], search: string, sort: string): Dict[] {
  const query = search.trim().toLocaleLowerCase();
  const timestamp = (value: unknown) => {
    if (typeof value === 'number') return value < 1e12 ? value * 1000 : value;
    const result = Date.parse(String(value || ''));
    return Number.isNaN(result) ? 0 : result;
  };
  return memos
    .filter((m) => (m.content || '').toLocaleLowerCase().includes(query))
    .sort((a, b) =>
      sort === 'title'
        ? memoTitle(a.content).localeCompare(memoTitle(b.content), 'zh-CN')
        : timestamp(sort === 'created' ? b.created_at : b.updated_at) -
          timestamp(sort === 'created' ? a.created_at : a.updated_at),
    );
}
