# DogO · 狗蛋

本地优先、以个人为中心的 AI 助理。计划使用 Pi 执行引擎，支持网页、macOS 和 Windows。

> **状态：P0 / 规划阶段。** 当前仅包含工程目录骨架、约定与需求草案，没有可运行的客户端，
> 没有接入 Pi 或模型，也没有安装包。文档中的路线图不代表已实现功能。

## 已确认方向

- 本地 Agent 是主助理；远端 Agent 是按任务委派的协作者，不是托管主会话的 SaaS 后端。
- 网页与桌面共享主要界面；桌面外壳和本地执行服务分离。
- TypeScript、React、Vite、Electron、Node.js、Pi SDK；使用 pnpm workspace 管理工程。
- 个人业务数据计划使用 SQLite，Pi 会话先沿用其自身存储；暂不绑定具体 SDK 版本。
- 手机端暂不实现；不直接迁移或覆盖旧客户端数据。

## 目录

| 目录 | 计划职责 |
| --- | --- |
| `apps/web/` | 浏览器与桌面共享界面 |
| `apps/desktop/` | Electron 外壳和系统集成 |
| `apps/runtime/` | 本地助理服务、Pi 适配、执行与数据 |
| `packages/contracts/` | 通信协议、事件与运行时校验 |
| `docs/decisions/` | 重要技术决策及原因 |

暂不创建通用多引擎框架或动态 UI 插件平台。每个目录的 README 说明职责，尚无业务实现。

## 项目文档

- [产品定义与待确认场景](PRODUCT.md)
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
当前没有运行时依赖，也没有 `dev`、`build` 或安装启动命令。

## 与旧项目的关系

[dsh-desktop-macos](https://github.com/Hcshenziyang/dsh-desktop-macos) 已停止维护。
DogO 是独立新项目，承接个人助理方向，不是旧客户端的直接升级版；目前不能替代旧版。
本次初始化不复制旧项目源码或素材，不读取旧数据；未来复用时保留相应许可、归属与受保护注释。

## 许可证

尚未选择项目许可证，不能将公开仓库视为已授予 MIT 等开源许可。许可证选定前不接受外部代码贡献。

## English

DogO is a planned local-first personal AI assistant powered by Pi, targeting web, macOS, and Windows.
The local agent coordinates work; remote agents receive explicitly delegated tasks rather than hosting the
primary assistant. This repository currently contains planning documents and a workspace skeleton only.
There is no runnable application or release yet. A project license has not been selected.
