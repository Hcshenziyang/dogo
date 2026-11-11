import { memoExcerpt, memoTitle, type Control, type Dict } from '../shared/presentation.js';
import { visibleMemos } from './presentation.js';

/** Add a memo picker to DSH's existing composer command menu when available. */
export function registerMemoPicker(ctx: any, control: Control, Icon: any, h: any) {
  ctx.inject(['commandUi', 'sessions', 'conversation'], (scope: any) => {
    const command = scope.get('commandUi');
    scope.effect(() =>
      command.register({
        name: 'dogo-memo',
        label: () => '备忘录',
        description: () => '选择备忘录，作为引用加入会话',
        icon: ({ size }: any) => h(Icon, { name: 'note', size: size || 16 }),
        available: (session: Dict) => !!scope.sessions.binding(session.sessionId),
        ui: {
          kind: 'popupSelect',
          searchLabels: () => ({
            placeholder: '搜索备忘录标题或摘要',
            empty: '还没有备忘录',
            noResults: '没有匹配的备忘录',
          }),
          options: async (_session: Dict, signal: AbortSignal) => {
            const memos: Dict[] = [];
            let cursor = '';
            for (let page = 0; page < 10000; page++) {
              signal.throwIfAborted();
              const result = await control('list', cursor ? { cursor } : {});
              signal.throwIfAborted();
              memos.push(...result.items);
              if (!result.next_cursor) break;
              if (result.next_cursor <= cursor) throw Error('备忘录分页无效，请重试。');
              cursor = result.next_cursor;
              if (page === 9999) throw Error('备忘录数量过多，请重试。');
            }
            return visibleMemos(memos, '', 'updated').map((memo) => ({
              id: memo.id,
              label: Array.from(memoTitle(memo.content)).slice(0, 80).join(''),
              detail: Array.from(memoExcerpt(memo.content)).slice(0, 180).join(''),
              signal,
            }));
          },
          onSelect: async (option: Dict, session: Dict) => {
            const binding = scope.sessions.binding(session.sessionId);
            if (!binding) throw Error('会话已关闭，请重新选择备忘录。');
            const input = scope.conversation.input.for(binding.ctx);
            const memo = await control('get', { id: option.id });
            if (option.signal?.aborted) return;
            if (scope.sessions.binding(session.sessionId) !== binding)
              throw Error('会话已关闭，请重新选择备忘录。');
            if (memo.deleted_at) throw Error('这条备忘录已删除，请重新选择。');
            if (typeof memo.content !== 'string' || !memo.content.trim())
              throw Error('这条备忘录没有内容。');
            // DSH consumes the picked command after onSelect returns. Insert in
            // the next turn so that a typed /dogo-memo token is consumed first.
            setTimeout(() => {
              try {
                if (option.signal?.aborted || scope.sessions.binding(session.sessionId) !== binding)
                  return;
                if (!input.actions.insertQuote('备忘录\n' + memo.content))
                  input.notify('error', '当前会话暂时不能加入引用，请重试。');
              } catch {
                input.notify('error', '备忘录引用未能加入，请重试。');
              }
            }, 0);
          },
        },
      }),
    );
  });
}
