# @dogo/web

React + TypeScript + Vite 的桌面连接外壳：标题栏、状态和失败恢复。资料、任务、设置与记忆已移入 [DSH Client 插件](../../packages/dsh-plugin/README.md)，Mac/Windows 共用这套 React 页面。

Electron 的隔离 WebContentsView 承载 DSH 页面；外壳不嵌 iframe、不获取认证地址、不复制 DSH UI。浏览器开发预览只显示外壳，不执行本机任务。原有重复业务页面已移除，旧任务在插件设置中只读查看。

```sh
pnpm dev:web
pnpm build:desktop
```

预览监听回环 5174；端口占用时报错。生产资源使用相对路径，由 Electron 加载。真实跨端网页入口仍由 services/mobile 共享界面提供。
