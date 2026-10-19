# @dogo/sync-client

服务端与 DSH 插件共享的 HTTPS 客户端、显式目录同步与记忆路径校验。没有服务启动入口，不依赖服务端应用。

`pnpm --filter @dogo/sync-client build` 生成 Node 可直接执行的模块；源码类型供 TypeScript 使用。现有 services 的同步、冲突和路径测试覆盖此包。
