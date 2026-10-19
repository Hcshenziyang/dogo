import test from "node:test";
import assert from "node:assert/strict";
import {
  createDemoTask,
  decideTask,
  devices,
  filterTasks,
  initialTasks,
} from "./model.ts";

test("seed is isolated on every reset and contains all demo states", () => {
  const a = initialTasks();
  a[0].unread = false;
  assert.equal(initialTasks()[0].unread, true);
  assert.deepEqual(
    new Set(initialTasks().map((task) => task.status)),
    new Set(["approval", "succeeded", "running", "queued"]),
  );
});
test("filters distinguish attention, active and completed tasks", () => {
  assert.equal(filterTasks(initialTasks(), "attention").length, 1);
  assert.equal(filterTasks(initialTasks(), "active").length, 2);
  assert.equal(filterTasks(initialTasks(), "done").length, 2);
  assert.equal(filterTasks(initialTasks(), "all", "WINDOWS").length, 1);
  assert.equal(filterTasks(initialTasks(), "all", "不存在的任务").length, 0);
});
test("new demo tasks are queued even when a device is online", () => {
  for (const device of devices) {
    const task = createDemoTask("  测试任务  ", "  只读检查  ", device.id);
    assert.equal(task.title, "测试任务");
    assert.equal(task.description, "只读检查");
    assert.equal(task.device, device.id);
    assert.equal(task.status, "queued");
    assert.match(task.activity[0].label, /尚未发送至真实设备/);
  }
});
test("blank task content is rejected and input lengths are bounded", () => {
  assert.throws(() => createDemoTask(" ", "说明", "mac"));
  assert.throws(() => createDemoTask("标题", "\n", "mac"));
  const task = createDemoTask("a".repeat(200), "b".repeat(5000), "win");
  assert.equal(task.title.length, 100);
  assert.equal(task.description.length, 4000);
});
test("approval changes only the target task and cannot be applied twice", () => {
  const original = initialTasks();
  const approved = decideTask(original, "approval-1", true);
  assert.equal(original[0].status, "approval");
  assert.equal(approved[0].status, "running");
  assert.equal(approved[0].unread, false);
  assert.equal(approved[1], original[1]);
  assert.deepEqual(decideTask(approved, "approval-1", false), approved);
});
test("rejecting approval leaves a visible terminal explanation", () => {
  const task = decideTask(initialTasks(), "approval-1", false)[0];
  assert.equal(task.status, "failed");
  assert.match(task.description, /没有继续执行/);
  assert.match(task.activity.at(-1)!.label, /拒绝/);
});
