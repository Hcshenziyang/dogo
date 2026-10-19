# @dogo/dsh-plugin

DSH `0.2.0-rc.2` 的 Host + React Client 插件，是 DogO 桌面业务后端与界面入口。不包含第二套 Agent 循环，不启动另一份 DSH。

- `src/index.mjs`：挂载原生会话桥、工具、业务服务、鉴权 API 与 effect 清理。
- `src/host/`：跨端中转、资料、项目、个人记忆、SQLite 与独占锁。DSH 服务由进程内适配器注入。
- `src/client/`：上游 sidebar/main 槽位的 DogO 面板；共享 hub-ui，系统操作通过有限原生桥。
- `src/sessions.mjs`：原生会话与执行回执、去重、审批；不自动重跑未知任务。
- `test/`：业务回归与旧调用方式夹具。生产不使用测试 Engine。

```sh
pnpm build:plugin
pnpm test:plugin
pnpm test:desktop
```

构建生成 `dist/client.js`，以 DSH ModuleLoader 协议加载，共用上游 React；产物不提交。包的 `dsh.client` 和 `./client` 导出让 DSH 自动发现前端插件。需通过包名加载 Host 插件，不能改成绝对文件路径后仍期待 Client 自动发现。

桌面启动器提供 `DOGO_HOST_SERVICES=1`、`DOGO_DATA_DIR`、启动身份及设备能力连接。缺少客户端凭据时不自动接入远程中转；浏览器认证来自 DSH 自身。私有 Host RPC 与浏览器 API 分离，后者不能修改本机权限或获取凭据。独立运行插件需要显式提供这些宿主配置，不是脱离客户端的默认守护服务。

业务数据保持原格式，首次打开有一致性备份；DSH 自身 session 数据由上游管理。生命周期使用 `ctx.effect()` 返回异步 disposer。部署与平台边界见 [架构](../../ARCHITECTURE.md) 和 [状态](../../STATUS.md)。
