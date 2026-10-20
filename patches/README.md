# 依赖兼容补丁

## dsh-native-memory 0.2.0 / DSH Session 0.2.0-rc.2

上游：[highland0971/dsh-native-memory](https://github.com/highland0971/dsh-native-memory)，MIT。

`callerOf()` 仍读取 `agent.session.events.length`，但锁定的 DSH Session 已移除 `events`。补丁改用公开 `session.seq`；这是工具入口观察到的日志长度/下一事件位置，保持原来的来源追踪语义，不减一，也不伪造旧 `events` 属性。

补丁修改 npm 包实际发布的 `lib/index.mjs`，通过 `pnpm-workspace.yaml` 的 `patchedDependencies` 与锁文件记录应用。上游版本号仍显示 `0.2.0`，不是新发布的 npm 版本。不修改 DSH 核心、审批策略、持久记忆 schema 或用户数据。

旧记忆清理另外为 `memory_forget` 增加可选 `version` 前置条件（完整 fact JSON 的 SHA-256）。审批前和审批后都检查版本，并在写入前检查取消信号；审批期间被修改的事实不能被归档。省略版本的原调用仍受审批期间版本检查保护。DogO 的 `legacy_forget` 强制要求版本，且确认依赖支持此参数后才调用原工具，不绕过原审批或直接编辑旧数据库。

```sh
pnpm install --frozen-lockfile
pnpm test:desktop
```

Mac 需要拉取源码、重新安装依赖后重新打包；仅拉取源码不会改变已有 DogO.app。`pnpm deploy --legacy --prod` 携带已修补模块，已在独立生产依赖目录验证。不要用 `npm install` 替代 pnpm，否则不会应用此配置。

[回归测试](../apps/desktop/test/native-memory.test.mjs) 使用实际安装的 SessionStore、记忆工具、StorageDomain 与 JSON 后端。仅工具注册和人工审批响应采用测试替身；验证来源位置、编辑、审批失败、关闭重开、全部八个工具的公共入口，以及兼容桥的范围隔离、归档、过期版本、审批期间并发修改和取消。未配置 session-query 时，search/import 检查预期的可用性错误，不将其称为完整 FTS/导入功能验收。

升级到上游版本时，应先确认 Session API 与归档版本校验均受支持并运行上述回归，再移除或调整补丁及锁文件记录。
