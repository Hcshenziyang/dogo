# DogO Python 后端

Python 3.13、FastAPI、SQLite，使用 uv 管理依赖和锁文件。后端可独立启动；DSH 插件与 Android 客户端分别位于仓库 `plugins/`、`mobile/`。

数据库仅保留 `accounts`、`devices`、`memos`、`dispatches` 四张表。项目是备忘录的文本字段；登录凭据放在设备记录中，创建请求去重放在对应业务记录中。

## 本地运行

在本目录执行：

```sh
uv sync --locked
uv run dogo create-user <username>
uv run dogo serve
```

`create-user` 交互读取密码，不通过命令参数传入。没有公开注册接口。默认监听 `127.0.0.1:8000`；交互 API 文档为 `/docs`，MCP 地址为 `/mcp/`。若当前 shell 尚未包含 uv 安装目录，可将命令中的 `uv` 换为 `~/.local/bin/uv`。

运行数据保存在 `data/`：SQLite、WAL 与本地签名密钥均被 Git 忽略。签名密钥首次启动时生成并持久保存，重启不会自动改变。通过 `DOGO_DATA_DIR` 指定私有数据目录；也可通过 `DOGO_JWT_SECRET` 指定至少 32 字符的密钥。

当前数据库版本为 2。已有版本 1 的开发数据库会被明确拒绝，原文件不会迁移或删除；本轮不做旧数据迁移，可指定新的 `DOGO_DATA_DIR` 启动。

部署使用一个进程 / 一个 worker。公网接入由反向代理提供 HTTPS / WSS，`DOGO_ALLOWED_HOSTS` 配置接受的主机名（逗号分隔，无端口）；需要浏览器 MCP / WebSocket 来源时配置 `DOGO_ALLOWED_ORIGINS`。当前 REST 未开放跨源浏览器访问，移动原生客户端不依赖浏览器 CORS。

## 认证与共享业务

`POST /api/auth/login` 接收以下字段，校验密码后直接登记或更新本设备，返回绑定设备的短期 JWT 和刷新凭据：

```json
{
  "username": "<username>",
  "password": "填写自己的密码",
  "device_id": "客户端首次启动时生成并持久保存的 UUID",
  "device_name": "电脑 B",
  "device_kind": "desktop"
}
```

每个客户端实例使用自己的稳定设备 ID。同一设备重新登录会替换旧访问令牌和刷新凭据，其他设备不受影响。后续 API 与 MCP 请求携带 `Authorization: Bearer <access_token>`。`/api/auth/refresh` 轮换刷新凭据，`/api/auth/logout` 仅撤销当前设备的登录凭据。没有独立登录记录表，也没有额外的设备注册或令牌签发接口。

设备表只保存当前刷新凭据的哈希、到期时间与令牌版本。`GET /api/devices` 列出设备，`DELETE /api/devices/{id}` 禁用设备并撤销凭据；使用账户密码再次登录可重新启用。`device_kind=mobile` 可记录来源；接收指令和回执使用桌面设备 WebSocket。账户与目标设备归属都由服务端校验。

REST 路由和 MCP 工具调用同一组应用服务，认证共用 `IdentityService`，由 `bootstrap.py` 统一装配。MCP 使用官方 Python SDK 的 Streamable HTTP，当前锁定 SDK 支持的协议为 `2025-11-25`；已做官方客户端验证，不代表已通过 DSH 原生接入验收。当前是预配置 Bearer 凭据接入，未实现通用 MCP OAuth 登录 / 自动发现。续期由客户端负责。

## 对外基本接口

HTTP 仅提供健康检查、登录/刷新/退出/当前账户、设备列表/禁用，备忘录列表/创建/读取/修改/追加/删除，以及一个在线会话转发入口 `POST /api/remote/call`。准确参数见 `/docs`。

MCP 仅提供 `list_memos`、`get_memo`、`create_memo`、`update_memo`、`append_memo`、`delete_memo`、`list_devices` 七个工具。创建备忘录可附带指令；不再提供独立投递创建、列表、查询、取消工具或 HTTP 接口，也没有设备领取/确认 HTTP 接口。

## 保存与派发

目标设备至少登录过一次后，即可向 `POST /api/memos` 提交；目标设备此时可以离线：

```json
{
  "request_id": "客户端生成并在重试时保留的唯一标识",
  "project": "个人账本",
  "content": "午饭 35 元",
  "category": "记账",
  "tags": ["餐饮"],
  "dispatch": {
    "instruction": "记录这笔支出",
    "target_device_id": "电脑 B 的设备 ID"
  }
}
```

不提供 `dispatch` 或 `plan` 就仅保存内容。即时备忘录和投递记录在同一 SQLite 事务提交；对应业务表中的 `(account_id, request_id)` 唯一约束防止重复创建，`request_hash` 校验重试输入。重试返回已有业务记录的当前状态，换输入复用旧 ID 返回 409，不保存历史响应。每次创建使用新的请求 ID，重试保持原 ID；保存并派发时，两条记录共用本次请求 ID。

- `project` 是分组文本，省略或空字符串表示未归类，可用同名查询参数筛选。当前无项目 CRUD 接口或 MCP 工具；以后项目需要独立内容时再拆表。派发时复制项目名称和正文，后续编辑不改变或重复派发旧指令。
- 修改、追加和删除只携带 `revision`，不再接收 `request_id`。旧版本重试返回 `409 revision_conflict`，不会重复追加。客户端必须读取最新内容并核对结果，不能自动换成最新版本盲目再发；服务端无法重放历史成功响应。客户端冲突副本界面尚未实现。
- 删除保留删除标记，并在同一事务取消尚未发送的 `pending` 指令。已经进入发送但未确认的 `leased` 指令会阻止删除，返回 `409 dispatch_in_flight`，即使回执已超时也不能当作撤回成功。设备确认接收后允许删除，但不停止 DSH 执行。
- 即时指令只在创建备忘录时附带；修改或追加不会重新派发旧指令。已有备忘录可以设置未来的定时计划。设备收到的 `session_mode` 固定为 `new`。
- REST `/docs` 和 MCP `tools/list` 是当前字段与工具接口的准确入口，避免另维护一份完整接口副本。

## 备忘录内的投递状态

创建、读取、修改、追加、删除都直接返回备忘录对象，列表返回的 `items` 也使用同一结构。创建响应不再套 `{memo, dispatch}` 外层。每条备忘录有 `dispatch` 字段：没有指令时为 `null`，否则包含指令 ID、目标设备、指令文本、投递时正文版本、状态、原生会话 ID 和接收时间。

- `pending`：等待发送，设备可以离线。
- `leased`：服务端已开始发送，等待设备持久接收回执。
- `accepted`：设备已确认接收，不代表 Agent 执行完成。
- `cancelled`：发送前随备忘录删除而取消。

用户端查询备忘录即可看到这些状态，不接触租约凭据和内部重试次数。正文编辑版本与投递状态独立变化，`revision` 不代表投递状态版本。

## 单次与周期计划

创建或更新备忘录时，可提供一个 `plan`，与创建时的即时 `dispatch` 互斥。例如每周五 08:30：

```json
{
  "request_id": "稳定请求标识",
  "content": "整理本周记录",
  "plan": {
    "instruction": "整理并归纳本周记录",
    "target_device_id": "电脑 B 的设备 ID",
    "mode": "weekly",
    "weekday": 4,
    "time": "08:30",
    "timezone": "Asia/Shanghai",
    "enabled": true
  }
}
```

`mode` 为 `once`、`daily`、`weekly`、`monthly`；单次使用 UTC 毫秒时间戳 `run_at`，周一至周日为 `weekday` 0–6，每月使用 `day` 1–31，时间使用 `HH:mm`。短月没有指定日期时使用月底。`timezone` 默认 `Asia/Shanghai`，支持系统 IANA 时区；夏令时不存在的本地时刻跳过，重复时刻取第一次。更新时省略 `plan` 保留原计划，传 `null` 移除；传对象替换计划并使用备忘录 `revision` 校验。返回的 `plan.id` 和 `next_run_at` 为服务端管理字段，不能原样作为输入提交。

服务在单进程中定时检查、启动时及设备连接时补查；每计划最多一条未确认投递，离线跨多个周期合并一次。设备确认接收后才计算下一周期；回执不表示执行完成。修改/暂停会取消未发送的投递，已发送待确认的内容不能撤回；暂停后恢复的周期从恢复后的下个正常时点开始。

## 设备 WebSocket 协议

桌面插件主动连接 `ws://127.0.0.1:8000/api/device/connect`。可通过 Authorization 请求头认证；浏览器无法设置该头时，在建立连接后 5 秒内发送 `{"type":"auth","token":"设备访问令牌"}`。令牌不放 URL。此协议仍需要认证和设备归属校验。

认证成功返回 `connected`，服务端直接推送指令正文，不再要求设备另发 HTTP 请求领取：

```json
{
  "type": "dispatch",
  "dispatch": {
    "id": "稳定的指令 ID",
    "memo_id": "备忘录 ID",
    "content_snapshot": "午饭 35 元",
    "project": "个人账本",
    "instruction": "记录支出",
    "session_mode": "new",
    "lease_token": "本轮接收凭据"
  }
}
```

上例仅列关键字段。设备持久记录指令 ID 并建立原生会话映射后，在同一个连接回传：

```json
{
  "type": "dispatch.ack",
  "dispatch_id": "收到的指令 ID",
  "lease_token": "收到的本轮接收凭据",
  "native_session_id": "DSH 原生会话 ID"
}
```

服务端持久确认后返回 `{"type":"dispatch.acknowledged","dispatch_id":"指令 ID"}`，再自动推送下一条。每设备保持一个连接、一次等待一条接收回执；这只限制交接，不要求等待 Agent 执行结束。格式错误、错误目标或过期回执返回 `error` 消息，连接可继续使用；认证失效则断开。`ping` / `pong` 用于维持连接，客户端续期后重新连接。

断线后不会取消或删除指令。重连时立即重发尚未确认的指令；租约仍有效时沿用原接收凭据，超过 60 秒则使用新凭据重投，指令 ID 始终不变。设备必须按指令 ID 持久去重并返回原会话映射；旧租约回执在重投后被拒绝，已确认且会话 ID 一致的重复回执可安全重发。服务器无法代替设备解决“DSH 已执行但本地记录中断”的不确定状态。

提交后即时唤醒、上线补查和每 30 秒低频补漏只在服务进程内部驱动推送，唤醒队列长度为 1。SQLite 是待办依据，不依赖内存消息或 WebSocket 在线持续存在。同一连接复用固定的在线会话调用，协议见下节。

## 在线会话转发

`POST /api/remote/call` 使用与备忘录相同的 Bearer 认证。请求 `{device_id, method, args}`；method 仅允许 `list/snapshot/create/prompt/cancel/workspaces/models/selectModel`。`workspaces`/`models` 读取远端 DSH 项目和可用模型；`create` 可带 `workspaceId`，`selectModel` 指定会话、提供商、模型及可选思考强度，由执行设备验证。服务端检查目标是同账户、启用且在线的桌面设备；离线立即失败。设备收到 `{type:"remote.call", id, call:{method,args}}`，通过 `{type:"remote.result", id, ok, value?, error?}` 回传。成功 HTTP 返回 `{value}`；请求关联 ID 由服务器生成，不能替代 prompt 的稳定 `args.requestId`。

设备插件再次校验参数，并调用本机 DSH。创建传稳定 `sessionId`，发消息传 `sessionId/requestId/text`，查询快照和停止传 `sessionId`，列表可带 `cursor`。访问方必须保留结果未知时的完整请求；断开等待、504 或设备断线均不能解释为“没有执行”。停止必须显式调用，关闭查看页面不会停止任务。

每设备最多 16 项、全局最多 128 项等待，12 秒超时；参数 JSON 上限 1 MiB、设备帧检查上限 2 MiB。中转等待仅在内存中，不增加数据库表、会话副本或离线远程调用队列。`GET /api/devices` 增加 `online`，与账户中设备是否启用 `active` 区分。返回结果前再次校验访问方认证，防止等待期间已撤销的客户端收到内容。

公网必须使用 HTTPS/WSS。当前没有端到端加密，服务器可见转发内容；此实现仍要求单进程部署。

## 代码与验证

后端采用 DDD 分层，目录位于 `src/dogo_server/`：

| 目录 / 文件 | 内容 |
| --- | --- |
| `domain/` | 身份/设备、备忘录、投递实体与值对象；版本、删除、租约、回执等业务规则和不含 HTTP 状态的领域错误。 |
| `application/` | `IdentityService`、`MemoService`、`DeliveryService`、`RemoteService`；命令、响应投影、仓储/工作单元/认证/中转端口。 |
| `infrastructure/sqlite/` | 四张表、连接、实体映射、仓储和工作单元。仓储共享用例事务，不单独提交。 |
| `infrastructure/` 其他模块 | 密码哈希与 JWT、提交后通知和低频补查、有界在线中转。 |
| `interfaces/` | REST、MCP、WebSocket、Pydantic schemas、认证依赖、错误映射与命令转换。 |
| `bootstrap.py`、`app.py`、`cli.py` | 实现装配、ASGI 生命周期和 CLI。 |

领域层与应用层只依赖标准库及内部核心层；框架和数据访问均放在外层。写用例使用一个 `BEGIN IMMEDIATE` 事务，跨仓储失败一起回滚，提交后再唤醒设备；读用例使用同一个只读快照。详细依赖与事务边界见 [架构说明](../ARCHITECTURE.md)。

旧顶层 `service.py`、`auth.py`、`db.py` 等内部模块已移除。测试工具通过 `create_app(...).state.container` 使用应用服务；定时功能启动时将数据库从版本 2 原子升级到版本 3，保留原数据和请求哈希，版本 1 仍拒绝启动。更新线上服务前应先备份数据库及凭据配置，先升级服务再更新客户端。

```sh
uv run pytest -q
uv run ruff check src tests
uv run ruff format --check src tests
```

测试包括账户隔离、重复写入、事务回滚、版本冲突、内容快照、并发发送、删除与发送竞争、断线重投、重复回执、丢唤醒补查、接口收敛，以及真实进程重启后的 HTTP / WebSocket / 官方 MCP 客户端往返。另有不连接数据库的领域规则测试、层间导入约束、提交后通知、只读快照测试；`tests/fixtures/v2.sql` 固定重构前表结构，用于验证已有数据库和创建请求哈希的兼容性，不含用户数据。

当前未实现：Android 远程会话界面、完整离线同步与独立冲突副本、远程审批/提问、定时任务执行结果回传和失败自动重跑、完整 OAuth 接入。当前更改尚未部署，未进行目标服务器容量测试；历史部署情况见 [当前状态](../STATUS.md)。
