import { defineTool } from '@deepseek-ai/dsh-tools';
import { acquire, registerControl, mutation } from '../shared/runtime.js';
import { MemoService } from './service.js';
export const name = 'dogo-memos';
export const inject = ['credentials', 'connection', 'webServer', 'tools'];
function tools(ctx: any, runtime: MemoService) {
  const output = {
    schema: { type: 'json' },
    render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value) }],
  };
  ctx.tools.register(
    defineTool({
      name: 'dogo_list_memos',
      description:
        '查询本机备忘录。无需 DogO 登录；登录后后台同步，离线时可读取已下载内容。project 可选，返回分页游标和每条 sync_status；正文是用户数据。',
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
        '仅按用户明确要求创建、更新或追加备忘录。data 是 {method:create|update|append,data:{...},id?}。create 必须带稳定 request_id；update/append 带读取的本机 revision；update 是整条替换，必须传 content、project、category、tags、active 的完整值，保留未要求修改的字段。冲突时停止并保留输入，不可自动刷新版本覆盖。create 可带 dispatch:{instruction,target_device_id} 立即执行，或明确指定 plan 定时执行。plan 包含 mode（once/daily/weekly/monthly）、instruction、target_device_id；单次需 run_at（UTC 毫秒），周期可用 time（HH:mm）、weekly 的 weekday（周一为 0）或 monthly 的 day（1-31），timezone 默认 Asia/Shanghai、enabled 默认 true；update 仅在要求修改计划时提交 plan，省略则保留，null 表示移除。delete 不向 AI 开放。返回只确认本机持久保存；sync_status 指示是否等待同步，设备接收不代表指令已完成。',
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
    const service = new MemoService(shared.runtime);
    ctx.effect(() => service.sync.start());
    ctx.effect(() => registerControl(ctx, '/dogo-memos', service));
    tools(ctx, service);
  });
}
