import { planSchema } from '../shared/plan.js';
import type { Dict } from '../shared/presentation.js';

function parts(stamp: number, zone: string): Record<string, number> {
  const fields = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(new Date(stamp));
  return Object.fromEntries(
    fields.filter((p) => p.type !== 'literal').map((p) => [p.type, Number(p.value)]),
  );
}
export function localTime(stamp: number, zone: string): string {
  const p = parts(stamp, zone);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}
export function toTimestamp(value: string, zone: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const [year, month, day, hour, minute] = match.slice(1).map(Number);
  const target = Date.UTC(year, month - 1, day, hour, minute);
  if (!Number.isFinite(target)) return null;
  try {
    let guess = target;
    for (let i = 0; i < 3; i++) {
      const p = parts(guess, zone);
      guess += target - Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
    }
    return localTime(guess, zone) === value ? guess : null;
  } catch {
    return null;
  }
}
export function defaultPlan(): Dict {
  return {
    instruction: '',
    target_device_id: '',
    mode: 'once',
    enabled: true,
    timezone: 'Asia/Shanghai',
    run_at: null,
    time: '09:00',
    weekday: null,
    day: null,
    run_at_input: localTime(Date.now() + 3600000, 'Asia/Shanghai'),
  };
}
export function planForEdit(plan: Dict): Dict {
  return { ...plan, run_at_input: plan.run_at ? localTime(plan.run_at, plan.timezone) : '' };
}
export function planPayload(plan: Dict): Dict | null {
  if (!(plan.instruction || '').trim()) return null;
  const result = {
    instruction: plan.instruction || '',
    target_device_id: plan.target_device_id || '',
    mode: plan.mode,
    enabled: plan.enabled !== false,
    timezone: plan.timezone || 'Asia/Shanghai',
    run_at:
      plan.mode === 'once'
        ? toTimestamp(plan.run_at_input || '', plan.timezone || 'Asia/Shanghai')
        : null,
    time: plan.time || '09:00',
    weekday: plan.mode === 'weekly' ? Number(plan.weekday ?? 0) : null,
    day: plan.mode === 'monthly' ? Number(plan.day ?? 1) : null,
  };
  if (result.mode === 'once' && !result.run_at) return null;
  const validated = planSchema.safeParse(result);
  return validated.success ? validated.data : null;
}

export function scheduleForm(
  React: any,
  ui: any,
  memo: Dict,
  devices: Dict[],
  busy: boolean,
  update: (patch: Dict) => void,
) {
  const { h, Button } = ui;
  const plan = memo.planEdited ? memo.planDraft : memo.plan ? planForEdit(memo.plan) : null;
  const change = (patch: Dict) => update({ planEdited: true, planDraft: { ...plan, ...patch } });
  const active = devices.filter((d) => d.kind === 'desktop' && d.active);
  const field = (label: string, child: any) =>
    h('label', { className: 'dg-schedule-field' }, h('span', null, label), child);
  return h(
    'section',
    { className: 'dg-dispatch dg-schedule' },
    h(
      'div',
      { className: 'dg-row dg-row-between' },
      h('span', { className: 'dg-small' }, '定时执行'),
      plan
        ? h(
            Button,
            { disabled: busy, onClick: () => update({ planEdited: true, planDraft: null }) },
            '移除计划',
          )
        : h(
            Button,
            {
              disabled: busy,
              onClick: () =>
                update({
                  planEdited: true,
                  planDraft: defaultPlan(),
                  instruction: '',
                  destination: '',
                }),
            },
            '添加定时任务',
          ),
    ),
    plan &&
      h(
        React.Fragment,
        null,
        field(
          '定时指令',
          h('textarea', {
            'aria-label': '定时指令',
            value: plan.instruction || '',
            maxLength: 32000,
            placeholder: '例如：整理最近的记录',
            disabled: busy,
            onChange: (e: any) => change({ instruction: e.target.value }),
          }),
        ),
        h(
          'div',
          { className: 'dg-schedule-grid' },
          field(
            '执行电脑',
            h(
              'select',
              {
                'aria-label': '定时目标电脑',
                value: plan.target_device_id || '',
                disabled: busy,
                onChange: (e: any) => change({ target_device_id: e.target.value }),
              },
              h('option', { value: '' }, '选择执行电脑'),
              plan.target_device_id &&
                !active.some((d) => d.id === plan.target_device_id) &&
                h('option', { value: plan.target_device_id }, '原目标设备（状态待核对）'),
              ...active.map((d) => h('option', { key: d.id, value: d.id }, d.name)),
            ),
          ),
          field(
            '执行频率',
            h(
              'select',
              {
                'aria-label': '执行频率',
                value: plan.mode,
                disabled: busy,
                onChange: (e: any) => change({ mode: e.target.value }),
              },
              ...[
                ['once', '单次'],
                ['daily', '每天'],
                ['weekly', '每周'],
                ['monthly', '每月'],
              ].map(([value, label]) => h('option', { key: value, value }, label)),
            ),
          ),
          plan.mode === 'once'
            ? field(
                '执行日期和时间',
                h('input', {
                  type: 'datetime-local',
                  'aria-label': '单次执行时间',
                  value: plan.run_at_input || '',
                  disabled: busy,
                  onChange: (e: any) => change({ run_at_input: e.target.value }),
                }),
              )
            : h(
                React.Fragment,
                null,
                plan.mode === 'weekly' &&
                  field(
                    '星期',
                    h(
                      'select',
                      {
                        'aria-label': '星期',
                        value: plan.weekday ?? 0,
                        disabled: busy,
                        onChange: (e: any) => change({ weekday: Number(e.target.value) }),
                      },
                      ...['周一', '周二', '周三', '周四', '周五', '周六', '周日'].map((x, i) =>
                        h('option', { key: i, value: i }, x),
                      ),
                    ),
                  ),
                plan.mode === 'monthly' &&
                  field(
                    '每月日期',
                    h(
                      'select',
                      {
                        'aria-label': '每月日期',
                        value: plan.day ?? 1,
                        disabled: busy,
                        onChange: (e: any) => change({ day: Number(e.target.value) }),
                      },
                      ...Array.from({ length: 31 }, (_, i) =>
                        h('option', { key: i + 1, value: i + 1 }, `${i + 1} 日`),
                      ),
                    ),
                  ),
                field(
                  '执行时刻',
                  h('input', {
                    type: 'time',
                    'aria-label': '执行时刻',
                    value: plan.time || '09:00',
                    disabled: busy,
                    onChange: (e: any) => change({ time: e.target.value }),
                  }),
                ),
              ),
        ),
        h(
          'label',
          { className: 'dg-schedule-toggle' },
          h('input', {
            type: 'checkbox',
            checked: plan.enabled !== false,
            disabled: busy,
            onChange: (e: any) => change({ enabled: e.target.checked }),
          }),
          '启用计划',
        ),
        h(
          'p',
          { className: 'dg-small dg-muted' },
          `时间按 ${plan.timezone || 'Asia/Shanghai'}；离线时等待上线，错过多次合并一次。`,
        ),
        plan.mode === 'monthly' &&
          h('p', { className: 'dg-small dg-muted' }, '当月没有所选日期时，在当月最后一天执行。'),
        memo.next_run_at &&
          h(
            'p',
            { className: 'dg-small dg-muted' },
            '下次：' + localTime(memo.next_run_at, plan.timezone),
          ),
        memo.plan &&
          !memo.next_run_at &&
          h(
            'p',
            { className: 'dg-small dg-muted' },
            memo.plan.enabled === false
              ? '计划已暂停'
              : '没有待安排的时间；请查看最近一次接收状态。',
          ),
        h(
          'p',
          { className: 'dg-small dg-muted' },
          '指令生成后保留当时内容；设备接收不代表执行完成。',
        ),
      ),
  );
}
