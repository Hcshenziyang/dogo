# 上游来源

- 仓库：https://github.com/liguobao/ds-harness-remote
- 版本：v0.5.18，提交 `fac5e6005b6b747889ef01193a64601bb14f53ad`，MIT，许可证见 LICENSE。
- `contract.ts` 原样来自 `packages/plugin/src/typert-gateway-contract.ts`。
- `carrier.ts` 提取自 `typert-gateway-switch.ts` 的 `local`、`createLocalOpen` 及辅助函数；保留 Peer、取消信号、旧/RC.1 参数顺序兼容，改为独立 `localCarrier` 工厂。
- `control-route.ts` 来自同名上游文件，改为可传入插件路由前缀，并限制请求体为 2 MiB。使用 DSH 原生浏览器认证；绕过 rc.2 通用 RPC 注册的服务注入问题，不绕过认证。
- 未引入全局网关切换、终端、Codex/ACP 或上游账号/中转运行时；没有重写这些功能的替代品。
- `tests/carrier.test.ts` 迁入并调整上游对应的 Peer、旧版/RC.1 流参数和错误测试场景。其余上游测试没有迁入，不计入本插件验证结果。

升级时对照上述文件与测试，单独验证实际 DSH 版本；不自动跟随上游发布。
