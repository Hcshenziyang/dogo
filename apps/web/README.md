# @dogo/web

React + TypeScript + Vite 的桌面外壳：工作区 / 资料箱 / 设置。DSH 页面由主进程的隔离原生视图承载，React 不嵌 iframe、不拿认证地址、不复制 DSH UI。
`LegacyApp.tsx` 保留历史任务与旧配置入口；切换到普通 DogO 页面不会销毁 DSH 文档，原生视图仅在工作区可见。
浅色绿橙配色与代码原生 DogO 图形；不依赖外部图片或网络字体。

- Electron 下通过 `window.dogo` 最小桥接操作真实 runtime。
- 浏览器下明确显示演示标记，使用内存虚构数据；不读本机文件、不调用模型、不持久化。
- 不直接导入 DSH、数据库或 Node.js 能力；不调用服务器令牌接口。
- 原生端可触发凭据文件选择与刷新；桥接只返回连接状态，不返回令牌。工作区视图 IPC 只接受可见性与重连，不接受 URL 或任意 JavaScript。预览拒绝真实工作区、领取与导入。

```sh
pnpm dev:web
pnpm build:desktop
```

预览固定在 `http://127.0.0.1:5174`，端口占用时失败，不自动换端口。
适配桌面最小窗口 940×640；手机界面由独立的 `apps/mobile` 负责。
生产资源使用相对路径，可以由 Electron 安全加载；当前浏览器预览不是完整网页客户端。
