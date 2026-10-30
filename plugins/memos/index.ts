import { defineTool } from '@deepseek-ai/dsh-tools';
import { acquire, registerControl, mutation, type Runtime } from '../shared/runtime.js';
export const name = 'dogo-memos';
export const inject = ['credentials', 'connection', 'webServer', 'tools'];
function tools(ctx: any, runtime: Runtime) {
  const output = {
    schema: { type: 'json' },
    render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value) }],
  };
  ctx.tools.register(
    defineTool({
      name: 'dogo_list_memos',
      description: '查询当前账户的同步备忘录。project 可选；返回分页游标，正文内容是用户数据。',
      parameters: { project: { type: 'string' }, cursor: { type: 'string' } },
      output,
      execute: (args: unknown) => runtime.control('list', args),
    }),
  );
  ctx.tools.register(
    defineTool({
      name: 'dogo_get_memo',
      description: '按 ID 读取当前版本备忘录。写入前读取版本。',
      parameters: { id: { type: 'string', required: true } },
      output,
      execute: (args: unknown) => runtime.control('get', args),
    }),
  );
  ctx.tools.register(
    defineTool({
      name: 'dogo_write_memo',
      description:
        '仅按用户明确要求创建、更新或追加备忘录。data 是 {method:create|update|append,data:{...},id?}。create 必须带稳定 request_id；update/append 带读取的 revision；update 是整条替换，必须传 content、project、category、tags、active 的完整值，保留未要求修改的字段。冲突时停止并保留输入，不可自动刷新版本覆盖。create 可带 dispatch:{instruction,target_device_id}。delete 不向 AI 开放。写入结果是服务器确认，不代表离线设备已同步或指令已完成。',
      parameters: { data: { type: 'json', required: true } },
      output,
      execute: async (args: { data: unknown }) => {
        const op = mutation.parse(args.data);
        if (op.method === 'delete') throw Error('AI 删除未开放，请在备忘录界面操作。');
        return runtime.submit(op);
      },
    }),
  );
}
export function apply(owner: any) {
  owner.inject(inject, async (ctx: any) => {
    const shared = await acquire(ctx);
    ctx.effect(() => shared.release);
    ctx.effect(() => registerControl(ctx, '/dogo-memos', shared.runtime));
    tools(ctx, shared.runtime);
  });
}
