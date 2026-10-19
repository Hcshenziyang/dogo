# DogO 服务器服务原型

提供任务信箱、MCP 工具、事件通知和共享记忆同步。服务器不运行模型或 Agent，不执行任务内容。
当前是单用户、可信设备、小规模部署 MVP；已有 Android/Mac 客户端和公网 HTTPS 部署，见 [部署与配对](DEPLOYMENT.md)。不是多用户平台，也不在服务器运行 Agent。

## 产品 v0.1.0 协议

`GET /v1/identity` 返回 `protocol: 2`。`POST /v2/hub` 接收 `{op,args}`：设备/项目登记、会话目录、分页历史、资料投递、创建/续聊、领取/结束、停止、提问/审批与回答。实体 `type` 与请求 `kind` 分开，原设备、实例与原生会话身份不可变。

`POST /v2/memory` 提供文件清单/读写、三方冲突、领取、合并和人工挂起；CAS 版本检查阻止陈旧合并覆盖新内容。模型只在客户端独立维护会话运行。双方版本及审计保留。

MCP 共 17 项工具：旧任务 6 项、会话/资料 7 项、记忆 4 项。完整参数以 `tools/list` 和 `src/hub.ts`、`src/memory.ts` 校验定义为准。新任务使用 hub 工具；下文 v1 API 为兼容旧版，不代表手机新任务仍要求 Mac 手动确认。

资料最多 2 个附件、每个 250 KiB；当前不支持任务附件。记忆仅可移植小写路径的 md/txt/json，单文件 256000 字符、总计 1000 文件/32 MiB。没有任意目录扫描、公开下载链接或多用户账号隔离。

## 启动

需要 Node.js 24+、pnpm 11.22.0；使用 Node 自带 SQLite。仓库根目录执行：

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm typecheck
pnpm test:services
export DOGO_CONFIG="$PWD/apps/others/services/config.example.json"
export DOGO_MAC_TOKEN="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')"
export DOGO_WIN_TOKEN="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')"
export DOGO_PHONE_TOKEN="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')"
pnpm --filter @dogo/services start
```

以上环境变量命令适用于 macOS/Linux shell。Windows PowerShell 请设置相同名称的 `$env:` 变量。
示例每次生成新令牌；实际部署应使用独立的凭据存储持久保存，不提交到仓库、任务内容或聊天中。
服务仅绑定回环地址。远端开发使用 SSH 隧道；公网部署需另配 HTTPS 反向代理、访问控制和限流，
并将代理使用的主机名加入 `allowedHosts`。不要直接把无 TLS 的 HTTP 暴露到公网。

配置项见 [config.example.json](config.example.json)：

- `database`：相对配置文件的位置解析；父目录自动创建。一个数据库只运行一个服务进程。
- `services`：`["tasks"]`、`["memory"]` 或两者；分开部署时使用不同端口、数据库及配置。
- `devices`：设备身份、令牌环境变量名、允许投递的信箱和是否允许共享记忆读写。
- `mailboxes`：逻辑路径到设备 ID 的映射，如 `/tasks/mac` → `mac`；不是磁盘目录或操作系统任务栏。
- 配置静态加载，修改/撤销令牌需重启。已入队任务保留创建时的执行设备，不随信箱改绑而转移。

所有请求都需要 `Authorization: Bearer <设备令牌>`；设备身份由令牌决定，不接受客户端伪造发起端。
不允许浏览器 Origin/CORS。Android/Mac 通过原生安全存储与原生请求接入，不能把长期设备令牌发布进网页代码。

## 任务闭环

手机投递 → 服务器持久化 → 通知 Mac → Mac 领单并执行 → 写回同一任务的结果 → 通知手机。

1. 发起端生成并保存 `requestId`，调用 `task_create` 或 `POST /v1/tasks`。
2. 在线执行端订阅 `/v1/events/stream`；收到 `task.created` 后读取任务，校验本机权限。
3. 执行端先本地持久化 `executionId`，再 `claim`。只有被指派的设备能领单。
4. Agent 执行过程中报告 `progress`，结束时报告 `succeeded` 或 `failed` 及 `result`。
5. 服务器将 `task.finished` 事件写入发起端与执行端信箱；发起端读取原任务取得结果。

服务器没有自动运行命令的逻辑。通知也不是执行授权；Agent 必须完成自己的权限确认。
首版结果为文本，可以携带代码差异、测试证据与产物引用；尚无大文件附件上传。

### 离线、重试与状态

- 未领单保持 `queued`，无自动过期；在线通知不是唯一来源，重连也可列出待处理任务。
- 事件日志与任务变更在同一 SQLite 事务内提交；通知按序重放，客户端处理完再保存游标。
- 重连传 `after` 或 `Last-Event-ID`；可能重复通知，必须按事件 ID/任务 ID 去重，不承诺恰好一次执行。
- 同一发起端重试相同 `requestId` 返回原任务；同 ID 不同内容返回 409。
- `claim` 的同一 `executionId` 重试返回原状态，**不是再次执行的许可**。不同执行 ID 不能抢占已领任务。
- 执行端每 15 秒 `POST /v1/heartbeat`，并为确认仍在执行的任务报告 `progress`（相同 message 可作任务心跳，不重复通知）。
  45 秒无设备心跳显示离线；运行中设备离线或任务进度过期增加 `executionUnknown: true`，不自动重跑。
  设备恢复在线不自动证明旧任务仍在运行，必须由原执行端核对后恢复任务进度上报。
- 失联恢复由原执行端核对本地执行记录；此原型没有自动接管、取消或强制重置接口。
- 发起端离线不取消任务。结果持久保存，回来后补读事件/任务即可。
- SSE 通知约 1 秒内发送，需 Agent 保持连接；不唤醒关机设备，不包含 APNs/FCM 手机系统推送。

### HTTP 接口

| 方法与路径 | 输入/作用 |
| --- | --- |
| `GET /v1/identity` | 当前设备身份与启用模块 |
| `POST /v1/heartbeat` | 执行端存活心跳，不等于任务进度 |
| `POST /v1/tasks` | `{requestId, mailbox, title, instructions}` |
| `GET /v1/tasks?after=0` | 本设备发起或接收的任务，每页最多 100 条；继续传 `nextCursor` |
| `GET /v1/tasks/:id` | 状态、进度、结果、执行端在线情况 |
| `POST /v1/tasks/:id/claim` | `{executionId}` |
| `POST /v1/tasks/:id/progress` | `{executionId, message}` |
| `POST /v1/tasks/:id/finish` | `{executionId, status, result}`，status 为 succeeded/failed |
| `GET /v1/events?after=0` | 本设备的持久事件，每页最多 100 条及 nextCursor |
| `GET /v1/events/stream?after=0` | SSE：id 为持久序号，data 为 `{seq, kind, resource, at}` |

任务只对发起端与被指派设备可读。事件仅包含任务 ID/记忆路径，正文需再通过鉴权接口读取。
每设备最多 4 个 SSE 连接；慢连接会断开，由客户端携带已处理游标重连。

### MCP

端点：`http://127.0.0.1:8787/mcp`（隧道/本机开发）或部署后的 HTTPS 地址。
使用官方 SDK 的无会话 Streamable HTTP，配置客户端发送设备 Bearer 令牌。
工具：`task_create`、`task_list`、`task_get`、`task_claim`、`task_progress`、`task_finish`。
其中 read/claim/progress/finish 的任务标识参数名为 `taskId`；其他字段与 HTTP 一致。
不提供通用管理员令牌，也不让模型指定任意收件设备或回传地址绕过配置。
任务通知走独立 `/v1/events/stream`，不是旧版 MCP HTTP+SSE 传输，也不假定 MCP 工具调用会唤醒 Agent。

## 共享记忆文件夹

只同步显式指定的共享目录。项目本地记忆放在该目录之外，既不扫描也不上传；
如果将某份项目概要人工放入共享目录，它才会被同步。完整聊天、附件不在当前默认范围内。

每台设备运行一个同步客户端，环境变量：

```sh
export DOGO_URL="http://127.0.0.1:8787"
export DOGO_TOKEN="$DOGO_MAC_TOKEN"
export DOGO_SHARED_DIR="/absolute/path/to/dedicated-shared-memory"
pnpm --filter @dogo/services sync
pnpm --filter @dogo/services sync --watch
```

目录必须已存在。单次同步适合手动按钮/记忆写入后调用；`--watch` 当前每 10 秒重新扫描，
不依赖文件监听丢事件，断网后继续保留本地修改并在后续轮次重试。两条命令不要同时常驻。

- MVP 支持 UTF-8 `.md/.txt/.json`，文件名/子目录为小写英文字母、数字、短横线或下划线。
  文件正文支持中文；中文文件名、二进制附件、隐藏文件、符号/硬链接不支持。
- 每文件最多 256000 个 JS 字符，服务最多 1000 个路径（含删除标记）及 32 MiB 当前文本。
- 服务以 SQLite 保存版本化文本，**不直接监听服务器磁盘文件夹**。本地目录通过 API 同步；
  HTTP JSON 请求上限 1 MiB，版本冲突返回 409。
- 使用本地基线与远端版本比较。两端冲突保留原文件与远端版本，在报告 `conflicts` 中列出路径，不覆盖。
  手动读出两份、决定内容后，可用当前 `baseVersion` 写入合并结果，并将本地文件改为相同内容，再同步。
- 删除通过 tombstone 传播；新端也能看到删除版本。服务回滚/丢失历史时报告冲突，不当成删除。
- 本地替换/删除前将旧内容备份到 `.dogo-sync/backups/*.json`，包含原路径、内容和时间；不自动清理。
- `.dogo-sync/state.json` 保存服务器/设备绑定与版本基线，不能跨设备复制使用；整个元数据目录不上传。
- 同步进程异常退出可能留下 `.dogo-sync/lock`：确认没有进程在同步后，才能人工移除该锁再重试。
- 同步目录应仅由可信本机进程使用；检查链接与网络等待期间的编辑，但不承诺抵御恶意并发文件系统修改。

记忆 API：`GET /v1/memory` 取得版本/hash 清单；`GET /v1/memory/file?path=...` 读内容；
`PUT /v1/memory/file` 输入 `{path, baseVersion, content}` 写入，`content: null` 为删除。
仅 `memory: true` 的设备允许访问，写入后向这些设备发送 `memory.changed` 事件。
当前同步客户端采用轮询；未来可用该事件触发同一同步函数，无需改变冲突规则。

不要把凭据、私钥或整个 home/代码仓库当成共享记忆。普通文本中是否含敏感信息仍由用户负责选择，
不是所有 `.md/.txt/.json` 天然适合上传。传输可用 HTTPS，但此版本**不是端到端加密**，服务器可读文本。

## 验证与限制

`pnpm typecheck`、`pnpm test:services` 验证 HTTP/MCP/通知/持久化/鉴权/文件同步及失败路径；
使用临时数据库、虚构任务与临时目录，不接触实际个人记忆，不调用模型。

已提供 systemd、Nginx HTTPS 与在线 SQLite 备份脚本；当前客户端轮询，Mac 必须人工确认执行。
尚未实现：移动系统推送、跨端审批/取消协议、数据库迁移、事件/任务留存清理、异地备份、
自动恢复、端到端加密、完整 OAuth/动态注册。服务器管理员可读任务正文与结果。
当前进程内 SQLite 不面向多实例高可用；数据目录应使用本地磁盘，勿置于网络共享或同步盘。

参考：[MCP 官方 SDK](https://ts.sdk.modelcontextprotocol.io/server)、[Node.js SQLite](https://nodejs.org/download/release/latest-v24.x/docs/api/sqlite.html)。
