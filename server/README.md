# DogO Python 后端

Python 3.13、FastAPI、SQLite，使用 uv 管理依赖。提供账户、设备管理和在线会话中转；备忘录 API、MCP 工具、投递与定时逻辑已移除。数据库只保留 `accounts`、`devices` 两张业务表。

## 本地运行

在本目录执行：

```sh
uv sync --locked
uv run dogo create-user <username>
uv run dogo serve
```

`create-user` 交互读取密码，不通过命令参数传入。没有公开注册接口。默认监听 `127.0.0.1:8000`；交互 API 文档为 `/docs`，MCP 地址为 `/mcp/`。若当前 shell 尚未包含 uv 安装目录，可将命令中的 `uv` 换为 `~/.local/bin/uv`。

运行数据保存在 `data/`：SQLite、WAL 与本地签名密钥均被 Git 忽略。签名密钥首次启动时生成并持久保存，重启不会自动改变。通过 `DOGO_DATA_DIR` 指定私有数据目录；也可通过 `DOGO_JWT_SECRET` 指定至少 32 字符的密钥。

当前数据库版本为 4。识别为 DogO 版本 2/3 的数据库启动时在同一事务删除旧备忘录与投递表，保留账号和设备；其他不受支持的数据库会被拒绝，不会被删除。

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

设备表只保存当前刷新凭据的哈希、到期时间与令牌版本。`GET /api/devices` 列出设备，`DELETE /api/devices/{id}` 禁用设备并撤销凭据；使用账户密码再次登录可重新启用。`device_kind=mobile` 可记录来源；在线会话中转使用桌面设备 WebSocket。账户与目标设备归属都由服务端校验。

REST 路由和 MCP 工具调用同一组应用服务，认证共用 `IdentityService`，由 `bootstrap.py` 统一装配。MCP 使用官方 Python SDK 的 Streamable HTTP，当前锁定 SDK 支持的协议为 `2025-11-25`；已做官方客户端验证，不代表已通过 DSH 原生接入验收。当前是预配置 Bearer 凭据接入，未实现通用 MCP OAuth 登录 / 自动发现。续期由客户端负责。

## 对外接口

HTTP 提供健康检查、登录/刷新/退出/当前账户、设备列表/禁用，以及 `POST /api/remote/call`。MCP 仅提供 `list_devices`；准确参数见 `/docs`。

设备以 Bearer 认证连接 `/api/device/connect`，只处理 `remote.call`、`remote.result` 和 `ping` / `pong`。单设备保持一个连接；认证失效或设备撤销后会断开。

## 在线会话转发

`POST /api/remote/call` 使用 Bearer 认证。请求 `{device_id, method, args}`；method 仅允许 `list/snapshot/create/prompt/cancel/workspaces/models/selectModel`。`workspaces`/`models` 读取远端 DSH 项目和可用模型；`create` 可带 `workspaceId`，`selectModel` 指定会话、提供商、模型及可选思考强度，由执行设备验证。服务端检查目标是同账户、启用且在线的桌面设备；离线立即失败。设备收到 `{type:"remote.call", id, call:{method,args}}`，通过 `{type:"remote.result", id, ok, value?, error?}` 回传。成功 HTTP 返回 `{value}`；请求关联 ID 由服务器生成，不能替代 prompt 的稳定 `args.requestId`。

设备插件再次校验参数，并调用本机 DSH。创建传稳定 `sessionId`，发消息传 `sessionId/requestId/text`，查询快照和停止传 `sessionId`，列表可带 `cursor`。访问方必须保留结果未知时的完整请求；断开等待、504 或设备断线均不能解释为“没有执行”。停止必须显式调用，关闭查看页面不会停止任务。

每设备最多 16 项、全局最多 128 项等待，12 秒超时；参数 JSON 上限 1 MiB、设备帧检查上限 2 MiB。中转等待仅在内存中，不增加数据库表、会话副本或离线远程调用队列。`GET /api/devices` 增加 `online`，与账户中设备是否启用 `active` 区分。返回结果前再次校验访问方认证，防止等待期间已撤销的客户端收到内容。

公网必须使用 HTTPS/WSS。当前没有端到端加密，服务器可见转发内容；此实现仍要求单进程部署。

## 代码与验证

`domain/` 和 `application/` 提供身份与中转用例，`infrastructure/` 负责 SQLite、认证和在线转发，`interfaces/` 提供 REST、MCP 与 WebSocket。

```sh
uv run pytest -q
uv run ruff check src tests
uv run ruff format --check src tests
```

测试覆盖身份、账户隔离、数据库迁移和拒绝未知库、远程会话及真实 HTTP / WebSocket / MCP。部署与验证的实际边界见 [STATUS.md](../STATUS.md)。
