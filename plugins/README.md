# DogO DSH 插件

| 插件 | 功能 |
| --- | --- |
| `dogo-devices` | 本机访问开关、执行目录、设备管理及经 Python 服务操作目标电脑会话 |
| `dogo-workspace` | 本机 Markdown 知识工作区、待办、JSON Canvas 与内嵌 Harness AI 会话 |

旧 `dogo-memos` 插件已经移除；知识工作区笔记、待办和画布不属于旧备忘录数据。

## 构建与安装

需要 Node 22+、pnpm 9。在 `plugins/` 执行：

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm test
pnpm run pack
```

产物为 `release/dogo-devices-0.2.13.tgz` 和 `release/dogo-workspace-0.1.7.tgz`。使用 DSH 自带插件管理器安装到目标 profile；桌面端更新后须完整重启 DSH，才能载入新的后台模块。设备远程访问需要 Python 服务；当前 Rust 服务不提供在线会话中转。

测试需使用独立的 `DSH_HOME` 和合成账户，避免操作个人 profile。一个 `DSH_HOME` 只允许运行一个 DogO 插件宿主。公网服务需 HTTPS/WSS；HTTP 仅允许回环地址。

## 知识工作区首版

`dogo-workspace` 独立安装于 DSH `0.2.2-rc.2`，保留项目与会话界面；从侧栏或会话标题区域打开知识工作区，点击“返回项目会话”切回。首次开启右侧 AI 对话时创建单独的 Harness 会话，使用当前 Harness 配置的模型。输入框上方可选择 AI 参考页面，默认跟随当前笔记、画布或待办；每条消息只自动携带页面类型、名称和文件标识，不自动附带正文，已有知识库读取工具仍可按需使用。已经发送或排队的消息保留发送时的页面。为防止目标混淆，同一个知识会话同时只允许一个窗口发送；关闭原窗口后可重试，异常退出后若仍提示冲突，需重启 DSH。“引用到 AI”仍可将当前内容加入会话草稿，发送后才交给模型。

笔记与画布保存在 `DSH_HOME/dogo/knowledge/`，分别是 `.md` 和 `.canvas` 文件，无需登录。笔记使用 CodeMirror 编辑，支持标题、加粗、斜体、链接、代码、待办勾选、普通表格预览和 HTTP(S) 图片显示，可切换源码模式；表格编辑仍使用 Markdown 源码，单元格内复杂格式暂不渲染。本地图片附件暂不可显示，混合换行的文件在编辑后可能统一为 LF。另支持新建、删除、标题搜索、笔记待办汇总，以及画布文本卡片拖动和连线；暂不支持嵌套目录、附件管理、完整 Markdown/Obsidian 插件、跨设备同步及旧备忘录自动迁移。默认示例可自行删除。画布中的其他节点类型可显示但暂不能在界面编辑内容。

知识工作区会话的工具执行仅允许读取知识文件和提交建议；建议单独保存，必须在界面预览并点击应用才写入。当前普通项目会话不受该限制。文件保存和应用建议均检查内容版本；外部修改后会保留编辑区草稿并拒绝覆盖。当前使用文件哈希进行乐观检查，不提供对其他进程并发写入的系统级锁。文件未单独加密。若 Harness 使用 PTC `run_code` 执行模式，知识会话为避免绕过确认而拒绝执行 `run_code`；需要使用原生工具执行模式。

## 设备访问边界

- 设置页管理登录、本机访问开关和执行目录；只有启用本机访问的电脑建立设备 WebSocket。
- 远程会话的项目、模型与思考强度由执行电脑的 DSH 处理；关闭访问页面不会停止已经开始的执行，停止需要明确操作。
- JWT/刷新凭据使用 DSH 原生 credential record；设备身份及执行配置保存在 `DSH_HOME/dogo/`，不要随意删除整个目录。
- 在线调用没有端到端加密，服务端可见转发内容；审批、用户提问、附件和复杂工具界面仍需在执行电脑处理。
- `dogo-devices` 的旧备忘录数据清理必须由目标 profile 的明确请求触发，只匹配旧备忘录文件和浏览器草稿键，不触及知识工作区或账户配置。

## 代码来源与验证

会话 carrier 和浏览器控制路由复用 `ds-harness-remote v0.5.18` 的必要部分，来源及许可证见 [vendor/dsh-remote/ORIGIN.md](vendor/dsh-remote/ORIGIN.md)。

`pnpm check` 和 `pnpm test` 验证插件；`scripts/smoke.mjs` 使用隔离 DSH、Python 服务和确定性模型验证登录、远程新建/续聊/停止及请求去重。`scripts/workspace-desktop-smoke.mjs` 与 `scripts/workspace-editor-context-smoke.mjs` 分别验证知识工作区桌面交互和页面上下文，均应使用隔离 profile。当前实际验证及未部署范围见 [STATUS.md](../STATUS.md)。
