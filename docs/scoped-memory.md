# 显式归属的助理记忆

2026-10-20。DogO 是以个人为中心的助理；记忆按归属划分，不按“概要/详情”划分。正常对话中由 Agent 维护，管理入口留在设置。执行宿主仍是 DSH。

## scope 与调用规则

| scope | 用途 | scopeId |
| --- | --- | --- |
| personal | 跨场景的偏好、习惯、目标、兴趣与经历 | 必须省略 |
| topic | 研究主题、旅行、选购等具体事情的资料、结论与进展 | 必填，先查已有主题，沿用稳定 ID |
| project | 持续项目的约定、决策与进展，不限于代码项目 | 必填，跨设备沿用稳定 ID，不用本地路径代替 |
| session | 某段会话的过程、临时上下文或交接 | 必填，明确的会话 ID |

这些是同一用户的记忆分类，不是多租户权限边界。每类都可包含概要和细节。主题记录不会隐式生成个人记忆；Agent 判断有长期个人价值时，显式创建或更新个人记录，用 `related` 关联。引用不自动加载正文，也不随删除级联删除其他记录。

唯一的新记忆工具是 `dogo_memory`：

```js
dogo_memory({
  action: "create",
  scope: "personal",
  text: "用户希望研究全双工语音模型与个人助理的应用",
  related: [{ scope: "topic", scopeId: "duplexjev-research" }]
})
dogo_memory({
  action: "create",
  scope: "topic",
  scopeId: "duplexjev-research",
  text: "调研快照：日期、模型发布状态、许可和来源网址；后续使用时重新核验"
})
dogo_memory({ action: "search", scope: "personal", query: "语音" })
dogo_memory({ action: "contexts", scope: "topic" })
```

- `create` 必须传 `scope` 和正文；非个人范围必须传 `scopeId`。同一次 DSH 调用重试得到相同记录 ID；不以此代替业务内容去重。
- `read` 必须传归属和记录 `id`；`update/delete` 还必须传上次读取的 `version`。版本是文件内容哈希，包括设置编辑和远端改动，旧版本不能覆盖新内容。
- `search` 在一个明确归属中查询，空查询列出记录；`contexts` 枚举某一 scope 已存储的上下文 ID。二者支持 offset/limit 分页，最大每页 50 条。搜索为不区分大小写的文本匹配，不宣称向量检索。
- `update` 可修改正文、标签和关联，不能隐式移动归属。来源同时保留初始写入与最后一次 Agent 修订的 sessionId、公开 Session.seq 和 callId。
- `delete` 删除活跃文件，原同步机制传播删除；备份和服务器历史仍保留，可在设置恢复。这不是彻底擦除功能。
- 保存结果区分本机成功与 `queued / waiting-for-connection / disabled` 同步状态；只有同步服务回执才能说明远端完成。

## 自动维护与读取

[系统提示词与工具定义](../packages/dsh-plugin/src/memory-tools.mjs) 说明各 scope 的差异、去重和修订、跨范围关联、历史时效、保存回执及记忆不得扩展权限。默认由对话中的 Agent 主动调用工具维护，不新增独立后台模型扫描器，也不承诺任意模型都会正确判断记忆价值。

个人记忆最多 8 条近期记录、每条正文最多 320 字符作为提示词摘录；完整内容按需 search/read。主题、项目、会话记录按需检索。摘录明确标记为不可信资料且可能不完整，不是新的指令或权限。未授权的原有只读会话仍不能调用记忆工具写入。

“Agent 自动维护记忆”与“同步全部范围的记忆”分开配置，新配置均默认开启，尊重已保存的关闭设置。关闭自动维护后工具写入被后端拒绝，显式读取与设置编辑仍可用。同步仍要求已连接、获授权的可信设备；不自动创建账号或增加设备权限。

## 持久化、同步与设置

所有新 scope 共用已有 `personal-memory` 目录（保留旧目录名以兼容安装数据），每条记录是带固定标识和来源的 JSON 文件：

```text
personal-memory/records/personal/self/<record-id>.json
personal-memory/records/topic/<scope-id-hash>/<record-id>.json
personal-memory/records/project/<scope-id-hash>/<record-id>.json
personal-memory/records/session/<scope-id-hash>/<record-id>.json
```

scopeId 原文保存在记录中；哈希只是可移植的文件路径，不提供加密。Agent 工具、设置编辑和同步共用串行队列及内容 CAS。新写入触发同步，离线保留文件，联网后沿用既有同步轮询补传。同步全部四种 scope 的文字记录和链接，不自动同步完整聊天、源码或附件；既有 1000 文件 / 32 MiB 同步限制不变。

设置页可以关闭自动维护/同步，查看归属、正文和来源，编辑、删除、导出及恢复服务器历史。结构化记录的正文编辑保留标识和来源。不是新增日常管理工作台。

结构化记录的并发修改保留双方，不交给旧的通用文本合并直接重写；维护端将其转入设置处理。非结构化旧文件沿用已有维护逻辑。同步来的无效记录在检索中报告错误，其他有效记录仍可访问；可从设置检查或恢复。

## 旧数据兼容

不自动迁移或重新分类用户已有记忆。生产 Host 隐藏旧插件的八个模型工具，并关闭其 profile 自动注入；原插件仍加载，其数据库不被删除。统一工具提供只读兼容：

- `legacy_read, scope: "personal", query`：检索旧个人文件，返回最多 10 个文件摘录；完整内容可在设置查看。
- `legacy_read, scope: "session", scopeId: 当前会话 ID, query`：通过原插件读取当前工作目录的旧 facts 和 profile。结果明确标记为旧工作区数据，不冒充新 session 记录。

旧数据如需进入新体系，由 Agent 在明确归属后写入。新工具的外层 DSH 工具限制仍生效，旧读取桥接不能用于修改旧库。

手机现有文件同步/设置可承载新记录；本轮没有给独立手机轻量 Agent 新增同名工具，也没有部署新 APK、服务或 Mac 安装包。
