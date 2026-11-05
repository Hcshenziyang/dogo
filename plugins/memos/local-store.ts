import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { mutation } from '../shared/runtime.js';
import { planSchema } from '../shared/plan.js';
import { Store } from '../shared/store.js';

const localPlan = planSchema.extend({ id: z.string().optional() }).nullable();
const dispatch = z
  .object({
    id: z.string(),
    instruction: z.string(),
    target_device_id: z.string(),
    status: z.string(),
  })
  .passthrough()
  .nullable();
const instruction = z.object({ instruction: z.string(), target_device_id: z.string() }).strict();
const outbox = z.object({
  token: z.string(),
  operation: mutation,
  local_revision: z.number().int().positive(),
});
const record = z
  .object({
    id: z.string().startsWith('local-'),
    request_id: z.string().min(1).max(128),
    request_hash: z.string().length(64),
    content: z.string().max(256000),
    project: z.string().max(100),
    category: z.string().max(100),
    tags: z.array(z.string().min(1).max(100)).max(30),
    active: z.boolean(),
    revision: z.number().int().positive(),
    created_at: z.number().int().nonnegative(),
    updated_at: z.number().int().nonnegative(),
    deleted_at: z.number().int().nonnegative().nullable(),
    owner: z.string().nullable(),
    remote_id: z.string().nullable(),
    remote_revision: z.number().int().positive().nullable(),
    dirty: z.boolean(),
    conflict_of: z.string().nullable(),
    plan: localPlan,
    plan_revision: z.number().int().nonnegative(),
    next_run_at: z.number().int().nullable(),
    dispatch,
    pending_dispatch: instruction.nullable(),
    outbox: outbox.nullable(),
  })
  .strict();
const database = z
  .object({ version: z.literal(1), last_owner: z.string().nullable(), items: z.array(record) })
  .strict()
  .superRefine(({ items }, ctx) => {
    if (new Set(items.map((item) => item.id)).size !== items.length)
      ctx.addIssue({ code: 'custom', message: 'Duplicate memo id' });
    if (
      new Set(items.map((item) => `${item.owner || ''}\0${item.request_id}`)).size !== items.length
    )
      ctx.addIssue({ code: 'custom', message: 'Duplicate memo request id for account' });
  });
export type LocalRecord = z.infer<typeof record>;
export const remoteMemo = z
  .object({
    id: z.string().min(1),
    request_id: z.string().min(1),
    content: z.string().max(256000),
    project: z.string().max(100),
    category: z.string().max(100),
    tags: z.array(z.string().min(1).max(100)).max(30),
    active: z.boolean(),
    revision: z.number().int().positive(),
    created_at: z.number().int().nonnegative(),
    updated_at: z.number().int().nonnegative(),
    deleted_at: z.number().int().nonnegative().nullable(),
    plan: localPlan.optional(),
    next_run_at: z.number().int().nullable().optional(),
    dispatch: dispatch.optional(),
  })
  .passthrough();
export type RemoteMemo = z.infer<typeof remoteMemo>;
export type Outbox = z.infer<typeof outbox>;
type Mutation = z.infer<typeof mutation>;
const queueSymbol = Symbol.for('dogo.local-memo-write-queues.v1');
const queues: WeakMap<Store, Promise<void>> = ((globalThis as any)[queueSymbol] ??= new WeakMap());

function fields(memo: LocalRecord | RemoteMemo) {
  return {
    content: memo.content,
    project: memo.project,
    category: memo.category,
    tags: memo.tags,
    active: memo.active,
  };
}
function planConfig(plan: LocalRecord['plan']) {
  if (!plan) return null;
  const { id: _id, ...config } = plan;
  return planSchema.parse(config);
}
function same(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right);
}
export function operationMatchesRemote(op: Mutation, value: RemoteMemo) {
  if (op.method === 'delete') return value.deleted_at !== null;
  if (op.method === 'append') return false;
  if (value.deleted_at !== null || !same(fields(op.data as LocalRecord), fields(value)))
    return false;
  if (op.data.plan !== undefined && !same(op.data.plan, planConfig(value.plan || null)))
    return false;
  return true;
}

function applyRemote(memo: LocalRecord, remote: RemoteMemo) {
  const changed =
    !same(fields(memo), fields(remote)) ||
    memo.deleted_at !== remote.deleted_at ||
    !same(planConfig(memo.plan), planConfig(remote.plan || null));
  Object.assign(memo, fields(remote), {
    remote_id: remote.id,
    remote_revision: remote.revision,
    deleted_at: remote.deleted_at,
    updated_at: remote.updated_at,
    plan: remote.plan || null,
    plan_revision: 0,
    next_run_at: remote.next_run_at ?? null,
    dispatch: remote.dispatch ?? null,
    pending_dispatch: null,
    dirty: false,
    outbox: null,
  });
  if (changed) memo.revision++;
}

function preserveConflict(items: LocalRecord[], memo: LocalRecord) {
  const request_id = randomUUID();
  const copy: LocalRecord = {
    ...memo,
    id: 'local-' + randomUUID(),
    request_id,
    request_hash: createHash('sha256').update(request_id).digest('hex'),
    revision: 1,
    created_at: Date.now(),
    updated_at: Date.now(),
    deleted_at: null,
    remote_id: null,
    remote_revision: null,
    conflict_of: memo.id,
    outbox: null,
    dirty: true,
    next_run_at: null,
    dispatch: null,
  };
  items.push(copy);
}

function view(memo: LocalRecord) {
  return {
    id: memo.id,
    request_id: memo.request_id,
    content: memo.content,
    project: memo.project,
    category: memo.category,
    tags: memo.tags,
    active: memo.active,
    revision: memo.revision,
    created_at: memo.created_at,
    updated_at: memo.updated_at,
    deleted_at: memo.deleted_at,
    remote_id: memo.remote_id,
    remote_revision: memo.remote_revision,
    plan: memo.plan,
    next_run_at: memo.next_run_at,
    dispatch: memo.pending_dispatch
      ? { ...memo.pending_dispatch, status: 'pending', local_pending: true }
      : memo.dispatch,
    sync_status: memo.conflict_of
      ? 'conflict'
      : !memo.owner
        ? 'local'
        : memo.dirty || memo.outbox
          ? 'pending'
          : 'synced',
  };
}

/** A single DSH runtime owns the directory lock; serialize all local mutations within it. */
export class LocalMemos {
  constructor(private readonly store: Store) {}

  private writes() {
    return queues.get(this.store) || Promise.resolve();
  }

  private serialize<T>(operation: () => Promise<T>) {
    const result = this.writes().then(operation);
    queues.set(
      this.store,
      result.then(
        () => undefined,
        () => undefined,
      ),
    );
    return result;
  }

  private async read() {
    const saved = await this.store.read<unknown>('local-memos-v1', {
      version: 1,
      last_owner: null,
      items: [],
    });
    const parsed = database.safeParse(saved);
    if (!parsed.success) throw Error('本机备忘录数据无效，已停止读取和写入；请检查本地数据文件。');
    return parsed.data;
  }

  async activateOwner(owner: string | null) {
    if (!owner) return;
    return this.serialize(async () => {
      const data = await this.read();
      let changed = data.last_owner !== owner;
      data.last_owner = owner;
      for (const memo of data.items) {
        if (memo.owner === null) {
          memo.owner = owner;
          changed = true;
        }
      }
      if (changed) await this.store.write('local-memos-v1', data);
    });
  }

  async list(input: unknown = {}) {
    const p = z
      .object({ project: z.string().optional(), cursor: z.string().optional() })
      .parse(input);
    await this.writes();
    const data = await this.read();
    const rows = data.items
      .filter(
        (m) =>
          (m.owner === data.last_owner || m.owner === null) &&
          m.deleted_at === null &&
          (!p.project || m.project === p.project) &&
          m.id > (p.cursor || ''),
      )
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return {
      items: rows.slice(0, 100).map(view),
      next_cursor: rows.length > 100 ? rows[99].id : null,
    };
  }

  async get(id: string) {
    await this.writes();
    const data = await this.read();
    const memo = data.items.find(
      (m) => m.id === id && (m.owner === data.last_owner || m.owner === null),
    );
    if (!memo) throw Error('未找到本机备忘录。');
    return view(memo);
  }

  async snapshot(owner: string) {
    await this.writes();
    return (await this.read()).items.filter((m) => m.owner === owner);
  }

  async currentOwner() {
    await this.writes();
    return (await this.read()).last_owner || 'unowned';
  }

  async findRemote(owner: string, id: string) {
    const memo = (await this.snapshot(owner)).find((m) => m.remote_id === id);
    return memo ? view(memo) : null;
  }

  async findCurrentRemote(id: string) {
    await this.writes();
    const data = await this.read();
    const memo = data.items.find((m) => m.owner === data.last_owner && m.remote_id === id);
    return memo ? view(memo) : null;
  }

  async ingest(owner: string, input: unknown) {
    await this.ingestBatch(owner, [input]);
  }

  async ingestBatch(owner: string, input: unknown[]) {
    const values = z.array(remoteMemo).parse(input);
    return this.serialize(async () => {
      const data = await this.read();
      const before = JSON.stringify(data);
      for (const remote of values) {
        let memo = data.items.find((m) => m.owner === owner && m.remote_id === remote.id);
        memo ??= data.items.find(
          (m) =>
            m.owner === owner &&
            !m.remote_id &&
            m.request_id === remote.request_id &&
            !m.conflict_of,
        );
        if (!memo) {
          memo = {
            id: 'local-' + randomUUID(),
            request_id: remote.request_id,
            request_hash: createHash('sha256')
              .update('remote:' + remote.request_id)
              .digest('hex'),
            ...fields(remote),
            revision: 1,
            created_at: remote.created_at,
            updated_at: remote.updated_at,
            deleted_at: remote.deleted_at,
            owner,
            remote_id: remote.id,
            remote_revision: remote.revision,
            dirty: false,
            conflict_of: null,
            plan: remote.plan || null,
            plan_revision: 0,
            next_run_at: remote.next_run_at ?? null,
            dispatch: remote.dispatch ?? null,
            pending_dispatch: null,
            outbox: null,
          };
          data.items.push(memo);
        } else if (!memo.outbox) {
          if (memo.remote_revision !== null && remote.revision < memo.remote_revision)
            throw Error('服务器备忘录版本发生回退，已保留本机内容并暂停同步。');
          if (
            memo.dirty &&
            (memo.remote_revision === null || memo.remote_revision !== remote.revision)
          ) {
            if (
              memo.remote_revision !== null ||
              !same(fields(memo), fields(remote)) ||
              !same(planConfig(memo.plan), planConfig(remote.plan || null)) ||
              !!memo.pending_dispatch
            )
              preserveConflict(data.items, memo);
            applyRemote(memo, remote);
          } else if (!memo.dirty && memo.remote_revision !== remote.revision) {
            applyRemote(memo, remote);
          } else if (!memo.dirty && !same(fields(memo), fields(remote))) {
            throw Error('服务器备忘录内容与版本不一致，已保留本机内容并暂停同步。');
          } else {
            memo.dispatch = remote.dispatch ?? null;
            if (!memo.plan_revision) {
              memo.plan = remote.plan || null;
              memo.next_run_at = remote.next_run_at ?? null;
            }
          }
        }
      }
      if (JSON.stringify(data) !== before) await this.store.write('local-memos-v1', data);
    });
  }

  async prepare(owner: string, id: string): Promise<Outbox | null> {
    return this.serialize(async () => {
      const data = await this.read();
      const memo = data.items.find((m) => m.owner === owner && m.id === id);
      if (!memo || memo.conflict_of || !memo.dirty) return null;
      if (memo.outbox) return memo.outbox;
      if (!memo.remote_id && memo.deleted_at !== null) {
        memo.dirty = false;
        await this.store.write('local-memos-v1', data);
        return null;
      }
      let operation: Mutation;
      if (!memo.remote_id) {
        operation = mutation.parse({
          method: 'create',
          data: {
            ...fields(memo),
            request_id: memo.request_id,
            ...(memo.plan && !memo.pending_dispatch ? { plan: planConfig(memo.plan) } : {}),
            ...(memo.pending_dispatch ? { dispatch: memo.pending_dispatch } : {}),
          },
        });
      } else if (memo.deleted_at !== null) {
        operation = mutation.parse({
          method: 'delete',
          id: memo.remote_id,
          data: { revision: memo.remote_revision },
        });
      } else {
        operation = mutation.parse({
          method: 'update',
          id: memo.remote_id,
          data: {
            ...fields(memo),
            revision: memo.remote_revision,
            ...(memo.plan_revision ? { plan: planConfig(memo.plan) } : {}),
          },
        });
      }
      memo.outbox = { token: randomUUID(), operation, local_revision: memo.revision };
      await this.store.write('local-memos-v1', data);
      return memo.outbox;
    });
  }

  async confirm(owner: string, id: string, token: string, input: unknown) {
    const remote = remoteMemo.parse(input);
    return this.serialize(async () => {
      const data = await this.read();
      const memo = data.items.find((m) => m.owner === owner && m.id === id);
      if (!memo?.outbox || memo.outbox.token !== token) return;
      const sent = memo.outbox;
      if (memo.remote_id && memo.remote_id !== remote.id)
        throw Error('服务器返回的备忘录标识不匹配，已保留本机内容。');
      const sentPlan = sent.operation.method !== 'delete' && 'plan' in sent.operation.data;
      const unsentPlan = memo.plan_revision > 0 && !sentPlan;
      if (memo.revision === sent.local_revision && !unsentPlan) {
        applyRemote(memo, remote);
      } else {
        memo.remote_id = remote.id;
        memo.remote_revision = remote.revision;
        memo.dispatch = remote.dispatch ?? null;
        if (sent.operation.method === 'create') memo.pending_dispatch = null;
        if (sentPlan && memo.plan_revision && memo.plan_revision <= sent.local_revision) {
          memo.plan = remote.plan || null;
          memo.plan_revision = 0;
          memo.next_run_at = remote.next_run_at ?? null;
        }
        memo.outbox = null;
        memo.dirty = true;
      }
      await this.store.write('local-memos-v1', data);
    });
  }

  async conflict(owner: string, id: string, token: string, input: unknown) {
    const remote = remoteMemo.parse(input);
    return this.serialize(async () => {
      const data = await this.read();
      const memo = data.items.find((m) => m.owner === owner && m.id === id);
      if (!memo?.outbox || memo.outbox.token !== token) return;
      preserveConflict(data.items, memo);
      applyRemote(memo, remote);
      await this.store.write('local-memos-v1', data);
    });
  }

  async submit(input: unknown, expectedOwner?: string | null) {
    const op = mutation.parse(input);
    return this.serialize(() => this.apply(op, expectedOwner));
  }

  private async apply(op: Mutation, expectedOwner?: string | null) {
    if (op.method === 'create' && op.data.dispatch && op.data.plan)
      throw Error('不能同时创建即时指令和定时计划。');

    const data = await this.read();
    if (expectedOwner !== undefined && data.last_owner !== expectedOwner)
      throw Error('DogO 账户已变化，请核对后重试；本机草稿已保留。');
    const now = Date.now();
    let memo: LocalRecord;
    if (op.method === 'create') {
      const hash = createHash('sha256').update(JSON.stringify(op.data)).digest('hex');
      const prior = data.items.find(
        (item) => item.request_id === op.data.request_id && item.owner === data.last_owner,
      );
      if (prior) {
        if (prior.request_hash !== hash) throw Error('创建请求标识已用于不同内容。');
        return view(prior);
      }
      memo = {
        id: 'local-' + randomUUID(),
        request_id: op.data.request_id,
        request_hash: hash,
        content: op.data.content,
        project: op.data.project,
        category: op.data.category,
        tags: op.data.tags,
        active: op.data.active,
        revision: 1,
        created_at: now,
        updated_at: now,
        deleted_at: null,
        owner: data.last_owner,
        remote_id: null,
        remote_revision: null,
        dirty: true,
        conflict_of: null,
        plan: op.data.plan || null,
        plan_revision: op.data.plan ? 1 : 0,
        next_run_at: null,
        dispatch: null,
        pending_dispatch: op.data.dispatch || null,
        outbox: null,
      };
      data.items.push(memo);
    } else {
      const found = data.items.find(
        (item) => item.id === op.id && (item.owner === data.last_owner || item.owner === null),
      );
      if (!found) throw Error('未找到本机备忘录。');
      if (found.revision !== op.data.revision)
        throw Error('备忘录已被修改，请读取最新内容后核对。');
      if (found.deleted_at !== null) throw Error('备忘录已删除。');
      memo = found;
      if (op.method === 'update') {
        Object.assign(memo, {
          content: op.data.content,
          project: op.data.project,
          category: op.data.category,
          tags: op.data.tags,
          active: op.data.active,
        });
        if (op.data.plan !== undefined) {
          memo.plan = op.data.plan;
          memo.plan_revision = memo.revision + 1;
          memo.next_run_at = null;
        }
      } else if (op.method === 'append') {
        if (memo.content.length + op.data.content.length > 256000)
          throw Error('追加后的备忘录超过长度限制。');
        memo.content += op.data.content;
      } else {
        memo.active = false;
        memo.deleted_at = now;
      }
      memo.revision++;
      memo.updated_at = now;
      memo.dirty = true;
    }
    await this.store.write('local-memos-v1', data);
    return view(memo);
  }
}
