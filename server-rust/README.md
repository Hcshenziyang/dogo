# DogO Rust 服务

独立 Rust 服务提供邀请码注册、登录认证与设备管理，使用 Diesel ORM 和 diesel-async 访问 SQLite；数据与 `server/` Python 服务分开。当前不提供远程会话中转或服务端 MCP。

旧备忘录 API 已移除；此前 Rust 数据库 v1 启动升级到 v2 时，在同一事务删除备忘录表，保留账号、凭据和设备。其他服务或非 DogO 数据库不会被当作 Rust 数据库迁移。数据库历史文件名 `dogo-memo.sqlite3` 暂时保留以便定位原库。

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

## Docker 部署

从仓库根目录为 Linux x86_64 构建镜像：

```sh
docker buildx build --platform linux/amd64 --load -t dogo-server:local server-rust
```

`deploy/compose.yaml` 记录当前服务器的旧 Portainer `dogo` 栈配置，镜像及容器仍使用历史名称；它不会自动更新为本地代码。该配置中：镜像只在本机，绑定 `127.0.0.1:8788`，由现有 Nginx 提供 HTTPS；数据保存在 `/var/lib/dogo-rust`，邀请码配置在仅 root 可读的 `/etc/dogo-rust/registration.env`。更新时需要先构建并导入新镜像，再把栈中的镜像标签改为新版本并重新部署；不要启用从远程仓库拉取本地镜像的选项。

服务器保留每日 SQLite 一致性备份，最多 14 份，保存在仅 root 可读的 `/var/backups/dogo-rust`。`deploy/backup.py` 使用 SQLite 备份 API，`dogo-backup.timer` 调用 `deploy/dogo-backup.service` 对应的服务器部署文件。

管理员可在交互终端创建账户，脚本隐藏密码输入并在服务器本机使用邀请码，不向终端显示邀请码：

```sh
ssh -t -i ~/.ssh/id_ed25519 root@dogo.hcblj.top /opt/dogo-rust/register-user.py
```

修改邀请码配置后需重新创建容器，使新环境变量生效。

## 接口

`POST /api/auth/register` 接收 `username`、`password`、`invite_code`，注册后仍需登录。当前密码长度要求 10–256 字符。现有插件登录页尚无注册界面，可使用支持 JSON 的 HTTP 客户端调用注册接口。

其他接口：

- `POST /api/auth/login`、`POST /api/auth/refresh`、`POST /api/auth/logout`、`GET /api/auth/me`。
- `GET /api/devices` 和 `DELETE /api/devices/{id}`，用于查看及撤销登录设备；不提供设备在线状态。

## 验证

```sh
cargo fmt --check
cargo clippy --locked --all-targets -- -D warnings
cargo test --locked
```

测试覆盖账号认证、设备撤销、数据库隔离，以及旧 Rust 数据库清除备忘录并保留账号和设备。线上实际部署版本以 [STATUS.md](../STATUS.md) 为准。
