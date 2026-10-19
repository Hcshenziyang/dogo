# DogO · 狗蛋

本地优先、以个人为中心的 AI 助理客户端。使用上游 DSH 执行后端，不复制或维护一份 DSH 核心。

产品需求以 [产品文档 v0.1.0](docs/product-v0.1.0.md) 为准：无人值守执行、原生会话续聊、资料箱和个人记忆文件夹同步。实现与实机验证分开记录。

> **状态：0.4.0 服务已部署、Mac 已安装、APK 已生成，产品基线 v0.1.0。** 新增个人账号/设备管理、网页入口、附件与记忆管理、手机独立 Agent、Mac 电脑操作/Codex/SSH 工具。
> Mac 已在线，Android 专用模拟器经生产服务、Mac 与实际模型的四项跨端复验通过；账号初始化、手机模型 API 配置和真机验收需用户完成。详见 [当前状态](STATUS.md)，不把模拟器通过当真机验收。Windows 当前暂缓。

## 已确认方向

- 各使用端的 Agent 按设备能力执行/委派任务；服务器不必运行 Agent，消息中转、信息同步和工具服务可独立实现。
- 网页与桌面共享主要界面；界面与执行职责分离，但远程上线依赖 DogO 应用启动并登录，不设独立常驻服务。
- TypeScript、React、Vite、Electron、Node.js、上游 DSH；使用 pnpm workspace 管理工程。
- Mac 任务数据使用 SQLite，DSH 会话沿用其自身存储；后端锁定 `0.2.0-rc.2`。旧 Pi 历史只保留查看。
- 手机已有独立 Android 客户端；明确发送后由已授权 Mac 自动执行，续聊仍是原设备原会话；不迁移旧客户端数据。
- 同一用户授权端同步专用个人记忆文件夹；项目源码与项目记忆不默认同步。支持手动及写入触发同步，冲突优先交给可用 Agent 处理。

首版已确认范围：本地 Agent 正常运行、持久记忆、macOS/Windows 屏幕观察/点击/输入及系统操作、
委派 Codex 编码并回收结果、SSH 服务器终端，以及跨端任务/消息中转。本轮按最新确认落地会话/任务/资料与个人记忆，完整方向与当前收敛范围分别见 PRODUCT.md 和产品文档。

## 目录

| 目录 | 计划职责 |
| --- | --- |
| `apps/web/` | 浏览器与桌面共享界面 |
| `apps/desktop/` | Electron 外壳和系统集成 |
| `apps/runtime/` | DSH 生命周期、任务/设备中转适配与本地业务数据 |
| `apps/mobile/` | React + Capacitor Android：发任务、前台刷新结果、原生安全凭据桥接 |
| `apps/others/` | 服务器工具及可独立部署的消息中转、同步配套服务 |
| `apps/others/services/` | 已实现的任务信箱/MCP/事件流和共享文件夹同步原型 |
| `packages/contracts/` | 通信协议、事件与运行时校验 |
| `packages/dsh-plugin/` | 薄桥接插件：DSH 任务、流式结果、只读授权；不包含 Agent 循环 |
| `packages/hub-ui/` | Mac/Android 共用跨端会话、资料、缓存和待发队列 |
| `docs/decisions/` | 重要技术决策及原因 |

暂不创建通用多引擎框架或动态 UI 插件平台。Mac 开发版运行 `pnpm dev:desktop`，见 [桌面说明](apps/desktop/README.md)。
`pnpm dev:web` 为明确标记的浏览器交互演示，不执行本机任务。
手机页面运行 `pnpm dev:mobile`，安装包运行 `pnpm build:apk`，见 [手机说明](apps/mobile/README.md)；服务器配置和客户端配对见 [部署说明](apps/others/services/DEPLOYMENT.md)。

## 项目文档

- [产品文档 v0.1.0](docs/product-v0.1.0.md)
- [产品入口与早期讨论](PRODUCT.md)
- [架构与边界](ARCHITECTURE.md)
- [阶段计划及验收](PLAN.md)
- [当前进度与下一步](STATUS.md)
- [技术选型决策](docs/decisions/0001-local-first-typescript.md)
- [贡献与验证约定](CONTRIBUTING.md)

## 验证目录骨架

使用 Node.js 24 或更高版本：

```sh
node scripts/check-layout.mjs
```

已安装 pnpm 时也可运行 `pnpm check`。这只检查目录、包声明和本地文档链接，**不是应用功能测试**。
服务器代码另用 `pnpm typecheck` 和 `pnpm test:services` 验证；启动配置见服务说明。
手机交互预览可用 `pnpm dev:mobile` / `pnpm build:mobile`；Android 打包需 JDK 21 和已授权的 Android SDK。

## 与旧项目的关系

[dsh-desktop-macos](https://github.com/Hcshenziyang/dsh-desktop-macos) 已停止维护。
DogO 是独立新项目，承接个人助理方向，不是旧客户端的直接升级版；目前不能替代旧版。
本次初始化不复制旧项目源码或素材，不读取旧数据；未来复用时保留相应许可、归属与受保护注释。

## 许可证

尚未选择项目许可证，不能将公开仓库视为已授予 MIT 等开源许可。许可证选定前不接受外部代码贡献。

## English

DogO is a local-first personal AI assistant client powered by upstream DSH, targeting web, macOS, and Windows.
Device-side agents coordinate work by capability. Message relay, personal-data synchronization, and server
tools can use independent services; a server-side agent is not required. A first server prototype supports
durable task mailboxes, MCP tools, event replay, and explicit shared-memory folder synchronization.
A Mac development client supports local tasks and a scoped DSH bridge. Android-to-Mac task delivery and result
retrieval were verified through the deployed HTTPS relay; the new DSH backend passed a local-model fixture,
while phone end-to-end acceptance and full coding capabilities remain pending.
A project license has not been selected.
