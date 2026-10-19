# @dogo/desktop

Electron 薄客户端：直接启动唯一 DSH 后端，管理窗口/托盘、系统凭据、原生授权和设备能力。`apps/runtime` 已移除。业务由 [DogO DSH 插件](../../packages/dsh-plugin/README.md) 承载；当前源码尚未替换已有 0.4.0 安装版，见 [STATUS](../../STATUS.md)。

## 启动与验证

Node.js 24+，pnpm 11.22.0：

```sh
pnpm install --frozen-lockfile
node apps/desktop/node_modules/electron/install.js
pnpm dev:desktop
```

启动命令先构建共享同步库、Client 插件和 React 外壳，再打开 Electron。无需启动单独 runtime 或 Vite。DSH 导航中的「DogO · 跨端与资料」包含跨端会话、资料、账号、个人记忆、本机权限与历史任务。模型和 DSH 插件配置使用上游设置。新会话直接使用 DSH，旧 Pi/兼容任务仅保留查看。

```sh
pnpm test:desktop
pnpm test:plugin
pnpm --filter @dogo/desktop acceptance
```

自动测试覆盖真实 DSH 启动、认证/Origin/方法边界、原生会话去重及跨重启续聊、插件中转执行/资料/记忆同步、数据备份锁、视图原生桥边界。模型和服务使用合成夹具，不调用用户真实模型。手动 acceptance 打开隔离 Electron 窗口；只有支持的桌面环境能验收完整原生 UI。

## 本机能力与安全边界

`src/host` 只管理 DSH 进程及 Host 协议；`src/native` 管理本机能力、授权文件和子进程。`dsh-preload.cjs` 只开放有限操作，主进程再次检查精确 origin、view 和主 frame。账号密码仅走原生服务，凭据保存在 Electron safeStorage，不返回令牌；文件选择和导出在原生对话框中完成。

- 电脑操作：macOS 原生辅助程序，需屏幕录制、辅助功能授权及合适模型。
- Codex：现有 CLI 登录、授权项目、workspace-write；非交互任务不能提高权限。
- SSH：用户配置并授权的 Host 别名、本机密钥与 known_hosts，严格主机校验。取消连接不保证远端命令副作用消失。
- 自动执行、本机能力和项目授权变更需要原生确认。这些限制只约束 DogO 工具，DSH 自身工具另循上游权限。

工具回归脚本：`scripts/accept-codex.mjs`、`accept-ssh.mjs`、`accept-computer.mjs`，均需显式 `--run`。Mac 和 Windows 共用 React 与后端代码；Windows 电脑操作/打包仍未实现或验证，不能将共用架构当作功能完成。

## 生命周期和数据

关闭窗口继续后台运行，托盘/Dock 可以重新打开。完整退出先检查本机/原生任务，用户确认后停止所有受管工作；不是独立守护服务。DSH 的客户端心跳过期停止中转，父进程断开触发退出。重连页面不会重新提交任务。

默认数据为 Electron `userData/local`，macOS 通常是 `~/Library/Application Support/DogO/local`。测试可设置 `DOGO_DATA_DIR`，完整外壳测试另用 `DOGO_USER_DATA_DIR`。

首次插件接管保留 `desktop.sqlite`、个人记忆文件和 DSH 会话，并做 SQLite 一致性备份。原生权限首次导入 `native-authorizations.json`；旧本机模型首次导入 DSH profile、保留 patch 备份，之后不覆盖 DSH 设置。必须先完整退出旧安装版，不能同时访问同一目录。备份与回退边界见 [架构](../../ARCHITECTURE.md)。

DSH 页面使用持久隔离分区和固定回环端口，认证 URL 只在主进程与该视图内。外部 HTTPS 链接需原生确认，其他协议拒绝；文字草稿依赖上游持久化，未发送图片附件不保证跨退出恢复。

## Mac 打包

在 Apple Silicon macOS 运行 `pnpm --filter @dogo/desktop package:mac`。脚本构建插件和页面、部署 desktop 生产依赖、编译原生 helper、核对官方 Node 校验和并打包。包内 Node 可独立加载插件，运行不依赖仓库或 Homebrew。产物位于 `release/`，仅本机 ad-hoc 签名，未公证，不提交 Git。

Linux 验证了生产依赖部署及真实 DSH 启动，不能据此声称 Mac 安装包或系统授权已验收。系统钥匙串确认、真实模型、Codex 登录与 SSH 目标仍由用户配置；不会复制凭据或绕过系统确认。
