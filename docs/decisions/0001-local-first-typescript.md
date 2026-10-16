# 0001：本地优先的 TypeScript 工程

日期：2026-10-16
状态：技术方向已确认；版本和集成方式待原型验证。

## 背景

旧项目绑定 SwiftUI、WKWebView 与 DSH。新产品以个人为中心，需要覆盖网页、macOS 和 Windows，
本地承担主助理工作，远端仅接收可委派任务。

## 决策

新建独立仓库，以 React + Vite 共享界面、Electron 桌面外壳、Node.js 本地服务集成 Pi SDK。
TypeScript 统一语言，pnpm workspace 管理模块。使用独立数据目录，不直接替换旧数据。
先采用 Pi Coding Agent SDK，不从裸 Agent Core 重建会话和压缩，也不立即支持多引擎。

## 原因与代价

统一技术栈便于维护和协议共享；浏览器与桌面可共用主要界面。
Electron 带来安装包和内存成本；独立服务带来生命周期、鉴权和升级协调工作。
Pi 不是完整个人助理产品；个人数据、权限及远端委派需要自行实现，稳定性与性能需实测。
Tauri 暂不采用，避免第一版同时承担 Rust 桥接、外部运行时打包和跨 WebView 验证。

## 复核条件

P1/P2 若发现 Pi 必需接口缺失、Windows 打包不可行或资源成本不可接受，再基于证据调整。
不以未经验证的“生态更好”“框架更轻”代替功能和性能验收。

## 参考

- [Pi SDK](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md)
- [Electron 进程模型](https://www.electronjs.org/docs/latest/tutorial/process-model)
- [Electron 安全建议](https://www.electronjs.org/docs/latest/tutorial/security)
