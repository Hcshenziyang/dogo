# 单用户部署与配对

公开文档不记录真实服务域名、用户目录或凭据。下文的 `dogo.example.com` 是占位域名；执行前替换为自己的已配置 HTTPS 域名。

## 0.4.0 已发布更新（2026-10-19）

个人账号 `/v3/auth`、同源网页、独立附件与版本化记忆管理已部署至 `20261019-hub-v040`。实际服务器 43 项测试通过，HTTPS 首页 200、匿名身份请求 401、现有 mac/phone 凭据仍有效。Mac 已覆盖安装 0.4.0、APK 已生成；客户端最后复验以 STATUS 为准。

`node apps/others/services/scripts/package-update.mjs <新文件.tgz>` 生成仅代码/测试/网页归档，不含凭据或用户数据。`update-server.sh <归档> <SHA-256> <YYYYMMDD-release> no https://dogo.example.com` 复用现有依赖和设备授权，备份配置/数据库、运行测试后原子切换；增加 publicOrigin 和受限 webRoot，不新增公网端口。失败回退代码/配置，新增数据库表保留。账号初始化后的旧版回退不保证新版登录会话兼容，不能当成无损账号恢复。

发布后网站根路径成为登录客户端，不再要求导入设备文件。首次 owner 账号只能由已配对桌面初始化；密码、恢复码由用户自行填写与保管。账号密码采用 scrypt，设备会话独立可撤销，网页为 HttpOnly/SameSite Cookie + CSRF；旧配对迁移后保留原设备 ID，停用旧文件需明确操作。新设备默认不具备任务路由或记忆权限。服务器仍能读取已同步内容，不是端到端加密。

`scripts/accept-web.mjs --run` 仅在完整仓库启动独立回环验收服务、合成账号/模型和真实 DSH，不连接生产服务器；不能当作生产启动方式。真实服务器验收和安装结果统一记入根目录 STATUS。

直接回退代码为 `20261018-hub-v2`；配置备份为 `/var/lib/dogo/backups/config-20261019-hub-v040.json`，部署前已运行数据库备份。发布包 SHA-256：`f9c5b14b7b0880705d50e4a25cff611b3adfefd57827a99c93acd0cdfc35383e`。没有更换设备令牌或新增公网端口。

2026-10-18：已有部署实例已升级至产品 v0.1.0 协议，真实地址只在私有配置中保存。
协议 API 保持鉴权；0.4.0 起浏览器根路径提供真实客户端和登录入口。
不运行服务器 Agent；只同步用户授权的 DogO 专用个人记忆目录，不修改博客或系统 Node。

## 当前组成

| 项目 | 位置/设置 |
| --- | --- |
| 服务 | `dogo-relay.service`，非登录用户 `dogo` |
| Node | `/opt/dogo/node-v24.22.0-linux-x64/bin/node`，不替换系统 Node 18 |
| 代码 | `/opt/dogo/current` → `/opt/dogo/releases/20261019-hub-v040` |
| 配置 | `/etc/dogo/config.json`，root:dogo 0640 |
| 令牌 | `/etc/dogo/credentials.env`，root 0600；不输出文件内容 |
| 数据 | `/var/lib/dogo/services.sqlite`，仅 dogo 可读写 |
| 网络 | 127.0.0.1:8787，经已有 Nginx 443 转发；未新增公网端口 |
| TLS | `/etc/letsencrypt/live/<你的域名>/`；现有 certbot.timer 自动续期 |
| 备份 | `/var/lib/dogo/backups/`，每天 04:15 起随机延迟至多 10 分钟，保留最近 14 份 |
| 限制 | systemd 内存上限 384 MiB、CPU 75%；Nginx 10 请求/秒、burst 30 |

Mac 与 phone 仍可使用原配对凭据；两端获准访问个人记忆，Windows 未配置。协议 v2 提供原生会话、执行轮次、资料、确认和记忆冲突，v3 增加账号；v1 旧任务保留。手机 0.4.0 可配置独立前台 Agent，并非 Android DSH。
凭据泄露必须撤销/轮换对应设备，不要共享一个管理员令牌。传输加密但不是端到端加密，服务器管理员能读任务和结果。

## 客户端配对

本机私有目录 `~/.local/share/dogo/relay/` 为 0700；`mac.json`、`phone.json` 为 0600。
文件包含 `{version,url,device,token}`，内容不要贴进文档、聊天或截图。

- Mac：打开已安装的 DogO.app（开发用 `pnpm dev:desktop`）；本机设备文件为 mac.json。凭据由系统安全存储加密，重启恢复连接。
- Android：同签名覆盖安装 0.4.0，不卸载旧版。已有配对可复用；首次优先账号登录，旧配对导入仍在兼容入口。
- Mac「跨端会话与资料 → 设置」开启无人值守；手机明确发送后交给原设备 DSH，不要求本机再次点击。旧版远端收件仍保留旧只读流程。
- 项目由 Mac 主动登记文件夹，手机只取得名称/状态；不上传项目源码。模型沿用本机 OpenAI 兼容服务。
- Mac 每 5 秒检查任务与记忆，手机前台约 6 秒刷新；可开启 Android 原生后台消息连接。没有 FCM/APNs，系统强制停止后需重新打开补读。
- 记忆在两端设置中开启，只扫描专用目录；不扫描项目、凭据或其他个人目录。服务器管理员可读内容，不是端到端加密。

## 运维（在服务器执行）

```sh
systemctl status dogo-relay --no-pager
journalctl -u dogo-relay -n 50 --no-pager
systemctl restart dogo-relay
systemctl start dogo-backup.service
systemctl list-timers dogo-backup.timer certbot.timer
nginx -t
```

不要在日志中打印请求头/令牌。服务日志当前不记录任务正文，Nginx 此虚拟主机关闭访问日志。
服务停止时新任务无法投递，但客户端保留本地 outbox；已收到任务和结果保存在 SQLite，重启不重跑执行。

### 备份与恢复边界

`scripts/backup.mjs` 使用 SQLite 在线备份接口，避免直接复制运行中的 WAL 数据库。当前备份与主数据同机，不能抵御磁盘/整机丢失；异地加密备份尚未配置。

恢复前停止 dogo-relay，保留当前数据库及其 `-wal/-shm` 文件作为独立回滚副本，再将选定的完整快照安装为 services.sqlite（dogo:dogo、0600），不混入旧 WAL，启动后检查数据。
这是人工恢复流程，未做生产恢复演练。回滚会丢失快照之后的任务，客户端可能保留较新的状态；不要据此自动重跑已执行任务。

### 更新与凭据

部署产物由 `pnpm --filter @dogo/services deploy --prod <临时目录>` 打包，再运行 `scripts/package-deployment.mjs <目录> <域名>`。
首次部署包保留相对 pnpm 符号链接，拒绝静默覆盖不同域名的凭据；首次包含令牌，必须私下传输、限制为 0600，不能公开上传。
`deploy-server.sh ... prepare` 是首次部署脚本，遇到已有配置即停止；不要在当前服务器重跑。更新使用新的 release 目录，检查依赖后切换 current，再重启/验证；保留上一版以便回退。
初次 v1 因 pnpm 链接打包不正确启动失败，当前已切到修复的 v2；v1 仅留作排错，不作为可用回退版本。

本轮采用 `scripts/update-server.sh` 进行仅代码更新：验证归档 SHA-256，先备份配置与数据库，在新 release 内测试，原子切换 current，再检查身份接口；失败回退。部署后保留 `20261016-relay-v2` 旧代码。该旧版不能读取新增 v2 会话，回滚仅是故障措施，不等于完整功能恢复。不要重跑 prepare 或换掉设备令牌。
`20261018-hub-v2` 上已跑 29 项服务测试，补齐 DSH 原生界面带前缀的会话 ID；直接回退版本为 `20261018-hub-v1`。只给已有 mac/phone 启用记忆授权。数据库/配置备份位于现有私有备份目录，非异地灾备。

设备令牌静态加载；轮换需要同步更新服务器凭据文件和对应设备私有配对文件，再重启服务并重新导入。此操作应另行确认，不能通过日志/公开链接分发令牌。
保存 Android 私有签名目录 `~/.local/share/dogo/android-signing/`，后续 APK 必须复用签名；不要将签名密码或密钥发到服务器。

## 历史验证（2026-10-16）

服务器 Node 24 下 24 项服务测试通过；真实 HTTPS 验证未授权拒绝、浏览器 Origin 拒绝、设备隔离、幂等与往返。
Android 原生测试包发出合成任务，在实际 Mac 窗口人工确认只读测试目录，原生测试成功读回 hello.ts 结果；Mac 重启保留连接/已回传状态。
用户真实手机 UI、模型分析、Windows、系统后台推送、记忆同步及异地灾备不在本轮验收范围。

最新验证以仓库根目录 [STATUS](../../../STATUS.md) 为准。
