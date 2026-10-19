import test from "node:test";
import assert from "node:assert/strict";
import {
  WorkspaceRepository,
  connectionSchema,
  createOutboxTask,
  emptyDraft,
  newWorkspace,
  retractOutbox,
  taskText,
} from "./workspace.ts";
import type { KeyValueStore } from "./workspace.ts";
import { toPublishInput, unconfiguredGateway } from "./gateway.ts";

function memory() {
  const data = new Map<string, string>();
  let fail = false;
  const storage: KeyValueStore = {
    async get(key) {
      return data.get(key) ?? null;
    },
    async set(key, value) {
      if (fail) throw new Error("disk full");
      data.set(key, value);
    },
  };
  return {
    data,
    storage,
    setFail(value: boolean) {
      fail = value;
    },
  };
}

test("fresh installs are empty local workspaces, never seeded as real results", async () => {
  const repo = new WorkspaceRepository(memory().storage);
  await repo.load();
  assert.equal(repo.snapshot().mode, "local");
  assert.equal(repo.snapshot().localTasks.length, 0);
  assert.ok(repo.snapshot().demoTasks.length > 0);
});
test("tasks, draft, mode, routing, and unread survive a repository restart", async () => {
  const disk = memory();
  const repo = new WorkspaceRepository(disk.storage);
  await repo.load();
  const draft = {
    title: "手机任务",
    description: "代码只读分析",
    device: "mac" as const,
  };
  const task = createOutboxTask(draft, newWorkspace().connection);
  await repo.update((state) => ({
    ...state,
    localTasks: [task],
    mode: "demo",
    drafts: { ...state.drafts, local: draft },
  }));
  const reloaded = new WorkspaceRepository(disk.storage);
  await reloaded.load();
  assert.deepEqual(reloaded.snapshot(), repo.snapshot());
  assert.equal(reloaded.snapshot().localTasks[0].requestId, task.requestId);
});
test("parallel saves serialize without losing either update", async () => {
  const repo = new WorkspaceRepository(memory().storage);
  await repo.load();
  await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      repo.update((state) => ({
        ...state,
        localTasks: [
          ...state.localTasks,
          createOutboxTask(
            { title: `任务 ${i}`, description: "内容", device: "mac" },
            state.connection,
          ),
        ],
      })),
    ),
  );
  assert.equal(repo.snapshot().localTasks.length, 20);
  assert.equal(
    new Set(repo.snapshot().localTasks.map((task) => task.requestId)).size,
    20,
  );
});
test("failed writes do not claim success or poison later saves", async () => {
  const disk = memory();
  const repo = new WorkspaceRepository(disk.storage);
  await repo.load();
  disk.setFail(true);
  await assert.rejects(
    repo.update((state) => ({ ...state, mode: "demo" })),
    /disk full/,
  );
  assert.equal(repo.snapshot().mode, "local");
  disk.setFail(false);
  await repo.update((state) => ({ ...state, mode: "demo" }));
  assert.equal(repo.snapshot().mode, "demo");
});
test("broken primary is recovered from the last valid backup", async () => {
  const disk = memory();
  const repo = new WorkspaceRepository(disk.storage);
  await repo.load();
  await repo.update((state) => ({ ...state, mode: "demo" }));
  disk.data.set("dogo.workspace.v1", "{broken");
  const recovered = new WorkspaceRepository(disk.storage);
  await recovered.load();
  assert.equal(recovered.recovered, true);
  assert.equal(recovered.snapshot().mode, "local");
  assert.equal(disk.data.get("dogo.workspace.v1"), "{broken");
});
test("unrecoverable data is not silently cleared or replaced", async () => {
  const disk = memory();
  disk.data.set("dogo.workspace.v1", "{broken");
  await assert.rejects(
    new WorkspaceRepository(disk.storage).load(),
    /已保留原始数据/,
  );
  assert.equal(disk.data.get("dogo.workspace.v1"), "{broken");
});
test("demo reset and switching do not mutate real task or draft", async () => {
  const repo = new WorkspaceRepository(memory().storage);
  await repo.load();
  const draft = { title: "真实", description: "待发", device: "win" as const };
  await repo.update((state) => ({
    ...state,
    localTasks: [createOutboxTask(draft, state.connection)],
    drafts: { ...state.drafts, local: draft },
  }));
  const real = structuredClone(repo.snapshot().localTasks);
  await repo.update((state) => ({
    ...state,
    demoTasks: [],
    mode: "demo",
    drafts: { ...state.drafts, demo: emptyDraft() },
  }));
  assert.deepEqual(repo.snapshot().localTasks, real);
  assert.deepEqual(repo.snapshot().drafts.local, draft);
});
test("outbox holds stable request and destination; retraction only affects unsent tasks", () => {
  const task = createOutboxTask(
    { title: " 测试 ", description: " 说明 ", device: "mac" },
    newWorkspace().connection,
  );
  assert.equal(task.status, "outbox");
  assert.equal(task.title, "测试");
  assert.deepEqual(toPublishInput(task), {
    requestId: task.requestId,
    mailbox: "/tasks/mac",
    title: "测试",
    instructions: "说明",
  });
  assert.equal(retractOutbox([task], task.id)[0].status, "cancelled");
  assert.equal(
    retractOutbox([{ ...task, status: "running" }], task.id)[0].status,
    "running",
  );
  assert.throws(() => toPublishInput({ ...task, status: "cancelled" }));
  assert.match(taskText(task), /目标信箱：\/tasks\/mac/);
});
test("bad connection, secrets in URL, duplicate and traversal mailboxes rejected", () => {
  const defaults = newWorkspace().connection;
  for (const url of [
    "http://example.com",
    "https://user:pass@example.com",
    "https://example.com?token=secret",
    "https://example.com/path",
    "bad",
  ]) {
    assert.equal(
      connectionSchema.safeParse({ ...defaults, url }).success,
      false,
    );
  }
  assert.ok(
    connectionSchema.safeParse({
      ...defaults,
      url: "https://relay.example.com",
    }).success,
  );
  assert.equal(
    connectionSchema.safeParse({
      ...defaults,
      routes: { ...defaults.routes, win: "/tasks/mac" },
    }).success,
    false,
  );
  assert.equal(
    connectionSchema.safeParse({
      ...defaults,
      routes: { ...defaults.routes, mac: "/tasks/../mac" },
    }).success,
    false,
  );
});
test("unconfigured gateway never reports a delivery or a fabricated result", async () => {
  await assert.rejects(
    unconfiguredGateway.publish({
      requestId: "id",
      mailbox: "/tasks/mac",
      title: "任务",
      instructions: "说明",
    }),
    /尚未连接/,
  );
  await assert.rejects(unconfiguredGateway.read("id"), /无法读取远端结果/);
});
test("oversized and invalid records are rejected before storage", async () => {
  assert.throws(() =>
    createOutboxTask(
      { title: "x".repeat(101), description: "说明", device: "mac" },
      newWorkspace().connection,
    ),
  );
  assert.throws(() =>
    createOutboxTask(
      { title: " ", description: "说明", device: "mac" },
      newWorkspace().connection,
    ),
  );
  const disk = memory();
  const repo = new WorkspaceRepository(disk.storage);
  await repo.load();
  await assert.rejects(
    repo.update((state) => ({
      ...state,
      localTasks: Array(501).fill(
        createOutboxTask(
          { title: "任务", description: "说明", device: "mac" },
          state.connection,
        ),
      ),
    })),
  );
  assert.equal(disk.data.size, 0);
});
