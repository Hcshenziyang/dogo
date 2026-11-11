# DogO Rust 备忘录服务

这是独立的 Rust 备忘录服务，提供邀请码注册、登录认证及备忘录同步接口。数据目录、数据库和签名密钥均与 `server/` 下的 Python 服务分开；**不读取、兼容或迁移旧账户及备忘录**。当前不支持设备指令、定时计划、远程会话或服务端 MCP；非空 `dispatch` / `plan` 请求会明确拒绝。

接入插件时应使用与旧服务不同的服务地址（域名或端口）：插件按服务地址和账户隔离本机记录，复用旧地址和用户名会沿用旧远端 ID，而新数据库不认识这些 ID。旧账户所属的本机记录不会自动迁入新账户；尚未归属账户的本机记录仍按现有规则在首次登录时归入该账户。

## 运行

需要 Rust 1.95 或更新版本。服务默认监听 `127.0.0.1:8789`：

```sh
cd server-rust
# 管理员自行安全设置 DOGO_RUST_INVITE_CODE，然后启动。
cargo run --release --locked
```

环境变量：

- `DOGO_RUST_INVITE_CODE`：管理员提供的注册邀请码。未配置或为空时关闭注册；当前是可重复使用的单个邀请码，修改配置并重启后生效。
- `DOGO_RUST_DATA_DIR`：独立数据目录，默认为当前目录下的 `data-rust/`。数据库文件名为 `dogo-memo.sqlite3`，新建文件权限为 0600。
- `DOGO_RUST_JWT_SECRET`：可选，至少 32 个字符。未配置时在独立数据目录创建 `rust-jwt-secret`，重启后复用。
- `DOGO_RUST_LISTEN`：监听地址，默认 `127.0.0.1:8789`。需要远端访问时应由反向代理提供 HTTPS。

新建数据目录权限为 0700；已有目录的权限不被修改。数据库包含应用标识，服务拒绝打开不属于本服务的非空数据库。不要将数据目录、邀请码或签名密钥提交到仓库。

## 接口

`POST /api/auth/register` 接收 `username`、`password`、`invite_code`，注册后仍需登录。当前密码长度要求 10–256 字符。现有插件登录页尚无注册界面，可使用支持 JSON 的 HTTP 客户端调用注册接口。

其余接口沿用现有备忘录插件需要的响应格式：

- `POST /api/auth/login`、`POST /api/auth/refresh`、`POST /api/auth/logout`、`GET /api/auth/me`。
- `GET /api/devices` 和 `DELETE /api/devices/{id}`，用于查看及撤销登录设备；不提供设备在线状态。
- `GET/POST /api/memos`、`GET/PUT/DELETE /api/memos/{id}`、`POST /api/memos/{id}/append`。列表支持分页和 `include_deleted=true`；修改、追加、删除使用 `revision`。

创建使用账户内稳定的 `request_id` 防止重试重复创建；修改和追加使用版本保护。删除保留标记，客户端可同步到删除状态。服务只保存已同步的备忘录，客户端离线编辑和冲突副本由插件处理。

## 验证

```sh
cargo fmt --check
cargo clippy --locked --all-targets -- -D warnings
cargo test --locked
```

插件的 `tests/memo-rust-live.test.ts` 可通过 `DOGO_RUST_TEST_URL` 和 `DOGO_RUST_TEST_INVITE` 连接正在运行的 Rust 服务；测试会创建账号和备忘录，只应对临时数据库运行。真实 DSH 的登录、MCP 工具和备忘录同步验收范围见仓库 `STATUS.md`。
