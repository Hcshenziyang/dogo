import { describe, expect, it } from 'vitest';
import { defaultPlan, localTime, planPayload, toTimestamp } from '../memos/schedule.js';
import { mutation } from '../shared/runtime.js';

describe('scheduled memo request', () => {
  it('converts the selected wall time in the plan timezone independent of browser timezone', () => {
    const stamp = toTimestamp('2026-11-03T20:30', 'Asia/Shanghai');
    expect(stamp).toBe(Date.parse('2026-11-03T12:30:00Z'));
    expect(localTime(stamp!, 'Asia/Shanghai')).toBe('2026-11-03T20:30');
    expect(toTimestamp('2026-02-30T20:30', 'Asia/Shanghai')).toBeNull();
    expect(toTimestamp('2026-03-08T02:30', 'America/New_York')).toBeNull();
  });
  it('preserves instruction text when a plan is paused', () => {
    const draft = {
      ...defaultPlan(),
      instruction: '  内容  \n',
      target_device_id: 'pc',
      mode: 'daily',
      enabled: false,
    };
    expect(planPayload(draft)!.instruction).toBe('  内容  \n');
    expect(planPayload({ ...draft, instruction: '   ' })).toBeNull();
  });
  it('keeps plan fields in exact create and update requests, including explicit removal', () => {
    const draft = {
      ...defaultPlan(),
      instruction: '整理',
      target_device_id: 'pc',
      mode: 'weekly',
      weekday: 3,
      time: '12:30',
    };
    const plan = planPayload(draft)!;
    expect(plan).toMatchObject({ mode: 'weekly', weekday: 3, day: null, run_at: null });
    const data = { content: '记录', project: '', category: '', tags: [], active: true };
    const created = mutation.parse({
      method: 'create',
      data: { ...data, request_id: 'create', plan },
    });
    expect(created.data).toMatchObject({ plan });
    expect(
      mutation.parse({ method: 'update', id: 'id', data: { ...data, revision: 1, plan: null } })
        .data,
    ).toMatchObject({ plan: null });
    expect(
      mutation.parse({ method: 'update', id: 'id', data: { ...data, revision: 1 } }).data,
    ).not.toHaveProperty('plan');
  });
});
