export type DeviceId = "mac" | "win" | "phone";
export type Status =
  | "outbox"
  | "approval"
  | "running"
  | "queued"
  | "succeeded"
  | "failed"
  | "cancelled";
export type Tab = "inbox" | "tasks" | "settings" | "devices";
export type Filter = "all" | "attention" | "active" | "done";
export type Device = {
  id: DeviceId;
  name: string;
  description: string;
  online: boolean;
  path: string;
};
export type Task = {
  id: string;
  title: string;
  description: string;
  device: DeviceId;
  status: Status;
  time: string;
  unread: boolean;
  category: string;
  result?: string[];
  activity: { label: string; time: string }[];
  requestId?: string;
  mailbox?: string;
  createdAt?: number;
  remoteId?: string;
  relayOrigin?: string;
  remoteUpdatedAt?: number;
  sendAttempted?: boolean;
};

export const devices: Device[] = [
  {
    id: "mac",
    name: "Mac mini",
    description: "编码 · 本机操作",
    online: true,
    path: "/tasks/mac",
  },
  {
    id: "win",
    name: "Windows PC",
    description: "Windows 环境验证",
    online: false,
    path: "/tasks/win",
  },
  {
    id: "phone",
    name: "此手机",
    description: "消息 · 任务 · 结果",
    online: true,
    path: "/tasks/phone",
  },
];
export const statusText: Record<Status, string> = {
  outbox: "待发送",
  approval: "待你确认",
  running: "进行中",
  queued: "待接单",
  succeeded: "已完成",
  failed: "未完成",
  cancelled: "已撤回",
};
export function initialTasks(): Task[] {
  return [
    {
      id: "approval-1",
      title: "手机端页面，准备开始修改",
      description:
        "Mac mini 请求修改 apps/mobile 下的页面文件，需要你确认本次权限。",
      device: "mac",
      status: "approval",
      time: "刚刚",
      unread: true,
      category: "编码任务",
      activity: [
        { label: "任务已送达 Mac mini", time: "14:20" },
        { label: "已检查项目目录", time: "14:21" },
        { label: "等待本次文件修改确认", time: "14:22" },
      ],
    },
    {
      id: "done-1",
      title: "任务中转服务，已经跑通了",
      description: "手机发起、Mac 接单、结果回传。这里是本次执行报告。",
      device: "mac",
      status: "succeeded",
      time: "8 分钟前",
      unread: true,
      category: "执行结果",
      result: [
        "任务写入与结果回传流程已完成演示验证。",
        "覆盖了离线补读、重复投递和身份隔离。",
        "演示报告：24 项检查通过，0 项失败。真实部署仍需单独验收。",
      ],
      activity: [
        { label: "手机发布任务", time: "13:48" },
        { label: "Mac mini 接单处理", time: "13:48" },
        { label: "检查完成，结果已回传", time: "14:14" },
      ],
    },
    {
      id: "running-1",
      title: "梳理共享记忆的同步边界",
      description: "正在整理冲突处理，以及哪些内容应该留在本地。",
      device: "mac",
      status: "running",
      time: "12 分钟前",
      unread: false,
      category: "分析任务",
      activity: [
        { label: "任务已接收", time: "14:10" },
        { label: "正在梳理共享与本地记忆", time: "14:12" },
      ],
    },
    {
      id: "queued-1",
      title: "检查 Windows 上的启动流程",
      description: "设备暂时离线。任务已保留，重新连接后再领取。",
      device: "win",
      status: "queued",
      time: "26 分钟前",
      unread: false,
      category: "环境验证",
      activity: [
        { label: "任务已保存到 Windows 信箱", time: "13:56" },
        { label: "等待设备上线，尚未开始执行", time: "13:56" },
      ],
    },
    {
      id: "done-2",
      title: "整理一份今天的工作摘要",
      description: "3 件已完成，2 件待跟进。回头接着做就好。",
      device: "mac",
      status: "succeeded",
      time: "1 小时前",
      unread: false,
      category: "工作摘要",
      result: [
        "已整理任务中转、共享记忆与手机页面三个方向。",
        "下一步：确认手机交互，再连接真实设备。",
      ],
      activity: [
        { label: "摘要已整理", time: "13:20" },
        { label: "结果已回传手机", time: "13:21" },
      ],
    },
  ];
}

export function filterTasks(tasks: Task[], filter: Filter, search = "") {
  return tasks.filter((task) => {
    const matches =
      filter === "all" ||
      (filter === "attention" &&
        ["approval", "failed", "outbox"].includes(task.status)) ||
      (filter === "active" &&
        ["outbox", "queued", "running"].includes(task.status)) ||
      (filter === "done" && ["succeeded", "cancelled"].includes(task.status));
    return (
      matches &&
      `${task.title} ${task.description}`
        .toLowerCase()
        .includes(search.trim().toLowerCase())
    );
  });
}

export function createDemoTask(
  title: string,
  description: string,
  device: DeviceId,
): Task {
  if (!title.trim() || !description.trim())
    throw new Error("请填写任务标题和具体说明");
  return {
    id: crypto.randomUUID(),
    title: title.trim().slice(0, 100),
    description: description.trim().slice(0, 4000),
    device,
    status: "queued",
    time: "刚刚",
    unread: false,
    category: "新任务",
    activity: [{ label: "已加入演示信箱，尚未发送至真实设备", time: "刚刚" }],
  };
}

export function decideTask(tasks: Task[], id: string, allow: boolean): Task[] {
  return tasks.map((task) =>
    task.id !== id || task.status !== "approval"
      ? task
      : {
          ...task,
          status: allow ? "running" : "failed",
          unread: false,
          description: allow
            ? "已在演示中允许本次修改，等待执行结果。"
            : "已在演示中拒绝修改，任务没有继续执行。",
          activity: [
            ...task.activity,
            {
              label: allow
                ? "用户允许本次修改（演示）"
                : "用户拒绝本次修改（演示）",
              time: "刚刚",
            },
          ],
        },
  );
}
