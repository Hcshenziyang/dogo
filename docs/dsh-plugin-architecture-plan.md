> 2026-10-19 实施更新：用户已要求执行本方案。A–D 与 E 的代码清理、Linux 自动/浏览器/依赖部署验证已落地；Mac/Windows 实机发布验证待进行。本文保留实施前评估与取舍，当前实际目录以 [ARCHITECTURE](../ARCHITECTURE.md) 为准。

# DogO 改版方案：DSH 后端、插件与薄客户端

日期：2026-10-19。评估基线：DogO `59e69d48e5fa2d81fba0fcc61b8f23db95e33e4f`，本地锁定的 DSH `0.2.0-rc.2`、Cordis `4.0.5`。

状态：用户已确认架构方向；本文是实现建议和迁移验收方案，尚未实施改版。不代表已经更改既有产品能力、生产部署或数据。本轮只修改方案文档与状态记录。

## 1. 结论与范围

可行，建议实施。DSH 已具备 Host 插件、Client 插件、会话控制、事件、API、存储和资源生命周期机制，DogO 无需继续维护独立的 Agent 业务运行进程。

目标是让 DSH 负责桌面 Agent 的执行和原生会话；DogO 插件负责跨端协作、资料与个人记忆等业务；客户端提供界面、系统凭据和设备能力。Electron 直接启动并管理 DSH，最终移除 `apps/runtime` 的独立进程和 JSON-lines RPC。

“唯一后端”限定为每台桌面设备的 Agent 后端。中转服务仍独立部署，负责离线消息和同步；Android 已确认的本机 AI SDK 轻量 Agent继续保留。本轮没有把 DSH 移植到 Android，也不将全部设备会话合并到一台服务器。

不 fork DSH，不复制上游 Agent 循环或原生会话存储。继续使用独立 DogO profile 与数据目录，保留用户已有会话、插件配置和授权边界。

## 2. 当前结构的问题

现有调用链：React → Electron → runtime（Node）→ DSH（Node）→ 模型/工具。DSH 工具访问设备能力时又反向调用 runtime 的本机 HTTP 服务。

runtime 源码约 1464 行，现有 DSH 插件约 563 行；这些只是代码规模，不是可直接删除的比例。主要重复或耦合点：

- `Engine` 集中持有存储、DSH、Hub、Relay、记忆和能力模块，各模块直接访问 `engine.*`，迁移前需要明确接口。
- `hub.mjs` 在 DSH 外部通过 `/dogo/*` HTTP 接口调用已经在 DSH 内部的 `sessionBridge`，增加状态同步与错误转换。
- 旧 `Engine.create/followup`、只读 preset 和 v1 relay 与新版原生会话路径并存。旧入口的单任务限制不能继续作为整个产品的并发模型。
- DogO 本地模型设置与 DSH 原生模型管理并存；`HubClient.poll()` 目前以 `settings.model` 判断后端是否可用，会把“DogO 本地模型未配置”与“DSH 无可用模型”混在一起。
- Electron 导入 runtime 的配对 schema，Mac 打包脚本以 runtime 部署目录作为依赖入口；移除进程时必须同时处理依赖和打包。
- 现有 README 中部分“手动领取/没有取消审批”等描述已落后于 v2 实现，迁移清单应以代码、最新产品要求及测试为依据。

## 3. 可行性证据与限制

以下来自本地实际安装包，不是对尚未检查的上游最新版本作保证。

| 能力 | 现有接口/证据 | 本轮验证程度 |
| --- | --- | --- |
| 插件注入与后台任务 | Cordis `inject`、`ctx.effect()`、`appReady` | 独立 DSH 探针通过，无 Agent 会话时定时任务继续运行 |
| 原生会话创建/恢复/续聊/取消 | `ctx.sessionController`、`ctx.agents`、`ctx.sessions` | 源码和类型核对；现有真实 DSH + 合成模型测试通过 |
| 流式内容、原生轮次和审批 | `agent/assistant-stream`、`session/event`、approval/questions waterfall | 现有原生轮次、手机回答及取消测试通过 |
| 自定义 HTTP 接口 | `ctx.webServer.register()`；鉴权由路由/连接层负责 | 独立探针通过自定义鉴权路由，未带凭据被拒绝 |
| Host 业务持久化 | `ctx.storageDomain`；插件也可拥有自己的 SQLite/文件 | 已核对接口并验证注入；探针用自有 JSON 验证重启，不声称已验证 storageDomain 读写迁移 |
| React 客户端扩展 | `dsh.client`、`./client` 构建产物、`ctx.slots`、`ctx.layout.selectPanel()` | 安装包文档和声明已核对；DogO 自定义页面打包/挂载尚待原型验证 |
| 资源卸载 | `ctx.effect(() => async () => cleanup())` | SIGTERM 和父进程 stdin 关闭两条路径都完成清理、状态落盘与第二次启动 |
| 通用客户端 API | API Gateway、Remote namespace、Connection | 文档与声明核对；DogO 自定义 namespace 与权限隔离尚待验证 |

重要边界：

1. DSH webhook 是外部事件创建会话的能力，但官方明确没有内置业务去重、持久队列、完成回执。不能用一个 webhook 替代当前 Hub 执行协议。
2. DSH 的 prompt 已提供 requestId 重试识别，但它不涵盖服务器领取身份、附件落盘、设备授权和回传游标。业务账本仍需存在。
3. `storageDomain` 当前没有跨表事务和自动数据迁移。第一轮保留插件私有 SQLite，避免同时改变进程、执行语义和存储格式。
4. Host 插件与 DSH 同进程，插件是可信代码，不是安全沙箱。耗时阻塞、未处理异常或泄漏可能影响 DSH；后台工作须有取消、限流、错误隔离和清理。
5. Client 模块支持 React 与界面插槽，不等于现有 Vite 页面可以直接复制为插件；需要按上游 client manifest、共享 React 依赖和 bundle 格式构建。

### 生命周期检查发现

当前 `packages/dsh-plugin/src/index.mjs` 和 `sessions.mjs` 用 `ctx.on('dispose', ...)` 注册清理。独立探针复现：按此写法，退出后预期清理标记没有写入；改用 `ctx.effect()` 返回异步 disposer 后，两条退出路径通过。Cordis 源码与声明也以 effect disposer 为资源清理机制。

因此不应归因为 SIGTERM 本身不支持优雅退出。改版前应将当前相关清理登记方式修正并加入回归，覆盖定时器、持久化队列、Agent handle 与 stdin listener。该探针说明了登记方式的问题；未据此断言生产数据已经丢失。本轮未改动这些运行代码。

## 4. 目标架构

```text
DogO 桌面客户端（Mac / Windows 共用）
  ├─ Electron：窗口、托盘、系统凭据、登录项、DSH 生命周期
  ├─ 受控设备桥：电脑操作、原生选择/导出、授权策略
  └─ DSH React 界面 + DogO Client 插件（最终形态）
                 ↕ 受认证、带版本的客户端接口
DSH Host（独立 Node 进程，唯一桌面 Agent 后端）
  ├─ 上游：模型、Agent、原生会话、工具、审批、流式事件
  └─ DogO Host 插件组合
       ├─ 协作：设备登记、项目授权、接单与回传
       ├─ 资料：附件、资料状态与本地存储
       ├─ 记忆：文件同步、冲突维护
       └─ 工具：Codex / SSH / 电脑能力入口
                 ↕ HTTPS，保持既有 v2 协议
DogO 中转服务：账号设备、离线请求、同步副本和附件
                 ↕
手机 / 浏览器客户端（各自受限的设备能力）
```

Electron 主进程只承担宿主职责；不把整个 Engine 搬进 Electron。重型命令使用子进程，原生 helper 可以保留，但不再另设一套通用 DogO Agent runtime。

两段式 UI 迁移：先保持现有 React 外壳及隔离的 DSH 视图，将后端切到插件；再将资料箱、设备、记忆及 DogO 设置逐项做成 Client 插件。使用正式插槽，不注入或修改上游 DOM/CSS。DSH 原生会话、模型和插件配置尽量直接复用。

只有 Client 插件原型覆盖所需导航、原生交互和隔离要求后，才合并双层界面。若某个 UI 插槽不满足需求，允许保留薄 React 外壳；这不阻碍取消 runtime 进程。

## 5. 模块与目录建议

第一阶段以现有 `packages/dsh-plugin` 为入口，内部拆模块，不立即发布大量 npm 包。建议结构如下，名称是提案：

```text
apps/
  desktop/src/
    host/                 # DSH 启停、健康检查、版本握手
    native/               # Mac/Windows 能力实现与系统安全存储
    main.* / preload.*    # 薄客户端入口
  web/                    # 迁移期 React 外壳，后续浏览器入口/共享页面
  mobile/                 # React + Capacitor，保留本机轻量 Agent
  others/services/        # 现有中转服务，第一阶段保持协议
packages/
  dsh-plugin/
    host/
      collaboration/      # 设备、项目、接单、审批回传
      artifacts/          # 资料附件
      memory/             # 同步与独立冲突维护
      tools/              # Codex、SSH、客户端电脑能力代理
      storage/            # DogO 业务状态与迁移
      api/                # 客户端控制接口
      upstream/           # 少量 DSH 版本相关映射
    client/               # 后续 React 界面插件
  contracts/              # 真正落实共享 schema、DTO、能力/版本契约
  hub-ui/                 # 手机和插件共用组件、状态与离线逻辑
```

`apps/runtime` 在切换和数据兼容验收完成前保留，之后删除或仅保留独立的历史兼容工具。第一阶段旧代码不为迁移而全部重写成 TypeScript；新增契约与插件接口建议用 TypeScript，按模块迁移，避免纯扩展名改造扩大范围。

`packages/contracts` 当前基本是骨架，需把各处实际 schema 有选择地收敛进去，不能假定现在已实现全端统一协议。插件不应直接依赖整个服务端应用包；从 `@dogo/services` 导入的同步客户端/文件操作可抽成小型共享库，同时保留校验行为。

## 6. 现有文件去向

| 当前文件/职责 | 目标处理 |
| --- | --- |
| `runtime/main.mjs` JSON-lines RPC | 由客户端到 DSH 插件 API 替代，最终删除 |
| `runtime/engine.mjs` | 拆除总协调对象；原生执行交给 DSH，业务编排分到插件服务，旧任务做隔离兼容 |
| `runtime/dsh.mjs`、`workspace-port.mjs` | 启停/profile/端口归桌面 host；Agent 执行方法改为插件内直接调用上游接口 |
| `runtime/hub.mjs` | 迁入 collaboration 插件，去掉对本机 `/dogo` 的 HTTP 往返 |
| `runtime/relay.mjs` | HTTPS 客户端、连接状态归协作模块；v1 路径独立兼容；配对 schema 进入 contracts |
| `runtime/store.mjs` | 迁入插件业务存储；保留必要任务投递账本，逐步停止旧执行模型的新写入 |
| `runtime/memory.mjs`、`memory-files.mjs` | 迁入记忆插件；维护用受限 DSH 会话，保留单次尝试与 CAS |
| `runtime/artifacts.mjs` | 迁入资料插件，校验完成后才能标记收到/开始执行 |
| `runtime/capabilities.mjs` | 拆分：DSH tools 定义与业务编排进插件，可信授权和原生调用留客户端桥 |
| `runtime/process.mjs` | 变为工具执行公共辅助代码，保持退出码、取消、输出上限和未知结果语义 |
| `runtime/readiness.mjs` | 汇总插件、DSH 和客户端能力的真实就绪状态；不再以旧本地模型配置作为总门槛 |
| `dsh-plugin/sessions.mjs` | 保留原生控制/审批集成，提供进程内服务；HTTP 包装仅供客户端需要的接口 |
| `dsh-plugin/index.mjs` | 拆为组合入口、兼容只读 preset、服务和资源登记；不继续堆积全部业务 |

Codex 模型订阅插件 `dsh-codex` 与 `dogo_codex` 编码委派工具不是同一件事，迁移时分别保留其语义。SSH/Codex 的业务实现可在插件，但涉及本机身份和授权的实际执行仍通过受控适配器；不为追求进程数量而绕开权限。

## 7. 状态、权限与生命周期契约

### 谁拥有数据

| 数据 | 唯一写入责任方 | 其他端如何使用 |
| --- | --- | --- |
| 原生会话、模型调用、工具事件 | DSH | 插件读取事件与控制接口；服务器保存投影副本 |
| 投递 requestId/executionId、回传游标、接收回执 | DogO 协作插件 | 中转服务保存网络请求状态，不能从缺失响应推断需要重跑 |
| 项目执行策略、远端开关 | 可信控制入口写入的业务配置 | 插件执行时检查，客户端设备桥独立检查本机权限 |
| 长期登录凭据、钥匙串 | 原生客户端安全存储 | 登录后通过私有引导通道提供最小所需的内存凭据，退出即撤销/清除 |
| 个人记忆文件及版本 | 专用本地目录 + 同步协议 | 不扫描源码、不合并 DSH 会话存储 |
| 资料附件 | 插件资料目录及服务器存储 | UI 只持标识/受控读取接口，不传任意本机路径 |
| UI 草稿、缓存、待发队列 | 各客户端 | 仍按账号、服务器和设备隔离 |

### 执行与授权

- 普通 Agent 的创建、排队、取消和模型选择交给 DSH。各原生会话独立；避免把旧只读入口的全局单任务锁带到新链路。
- 业务仍采用持久接收账本：先保存执行身份，再领取、准备附件、记录接收、提交 DSH。逐个崩溃窗口验证。无法确认接收结果时标记未知/中断，不能换 requestId 重发。
- DSH 和服务器不是一个事务域，不能承诺分布式“恰好一次”。通过固定身份、去重与核对提供明确的恢复语义。
- 内部 DSH 调用使用会话 controller；公开接口提供有限动作，不能暴露任意命令/路径或通用主进程 RPC。
- 插件后台接单由程序运行，不依赖模型主动调用工具；只有应用已启动、已登录、原设备身份有效且策略允许时才接单。
- DSH 原生操作员连接与 DogO 中转账号认证分别管理。不能将 DSH operator token 发给手机作为跨端授权，也不能把 localhost 当成自动可信。
- 当前插件 `/dogo` 路由拒绝 Origin，因此现有浏览器 React 不能直接把原调用地址替换过去。阶段一继续经 Electron 主进程代理；阶段二使用 DSH 正式 Connection/Gateway 或单独受认证的扩展 API。
- 配置/授权接口与模型工具接口分离。模型不能获得“授权自己”工具。插件同进程权限很强，本方案不宣称能隔离恶意插件或 DSH 原生 shell；OS 级隔离属于独立问题。
- 将原来的 `/remote-policy` 短期有效状态改为有明确作用域和过期时间的客户端连接/授权状态，确保退出、断线和账号切换后停止新接单。这里的协议是建议设计，尚未实现。

### 启停、失败与升级

1. Electron 准备专用 profile，启动 DSH，完成后端版本与插件能力握手；插件可无登录初始化，但不得接真实远端任务。
2. 用户登录后提供受限连接信息与策略；必要子模块就绪才公布设备能力。断网允许本地 DSH 会话继续，跨端显示离线。
3. 正常退出先停止接单，再处理在途任务、保存回执与游标、等待插件 effect 清理，最后停止 DSH；强制终止后的恢复不得自动重放。
4. 父进程意外退出采用 stdin 关闭或等价宿主信号；与“普通 UI 页断开”的语义区分，关闭一个页面不能错误终止整个后端。
5. 初期把 DSH + DogO 插件固定为一起验收的版本组合。启停消费者前检查 API/schema 能力，版本不兼容时关闭受影响业务并给出明确状态。
6. 插件卸载/重载前暂停新接单并排空任务。上游支持 HMR，不代表运行中的跨端写任务可以随意热更新。未验证前使用受控重启。

## 8. 分阶段实施与验收

各阶段独立交付，前一阶段达标后再推进。估算应以第一个迁移原型结果为依据，不在未确认打包/UI工作量前承诺固定天数。

| 阶段 | 交付物 | 完成标准 | 风险 |
| --- | --- | --- | --- |
| A：契约与生命周期 | 清理登记修正、typed 边界、独立 Host 插件入口、版本握手 | 无 runtime 的 DSH 可启动/关闭；定时器、挂起请求、持久化正确清理；旧链路回归通过 | 低到中 |
| B：协作业务插件化 | Hub/Relay/资料/记忆进入 Host 插件；保持 UI、服务 v2 协议 | 接单、续聊、审批、取消、附件、双向记忆与离线回传通过；同一设备只有一个业务消费者 | 高 |
| C：客户端直接连接 | Electron host 启动 DSH，设备桥与凭据引导，更新打包脚本 | 进程树无 DogO runtime；Mac 实机退出/重启/凭据/原生能力通过；旧数据可读且不重放 | 高 |
| D：界面插件化 | 先实现一个资料箱/设备页 Client 插件，再迁记忆与设置 | 原生会话和草稿不因切页丢失；UI 插件启停/重连/构建正常；原生权限不泄漏 | 中到高 |
| E：收尾与平台 | 删除失效 RPC/重复状态与旧依赖、更新文档；Windows 适配单列 | 干净安装及升级均通过；无新代码依赖旧 Engine；各平台验收分别报告 | 中 |

阶段 A 的最小实现切片：启动一个带 DogO 服务的 DSH profile，客户端可读插件状态，通过插件创建/续聊原生会话，验证事件和干净退出。已有独立探针只证明基础机制，尚未完成这一产品切片。

阶段 B 初期保留现有 HTTP/v2 语义，通过进程内 facade 替换调用，不同时换服务端协议、重写 UI 或升级 DSH。旧 runtime 可以暂作外壳适配，但其后台消费者必须关闭，不能与插件同时领取同一账号设备的任务。

阶段 C 移动 runtime 的依赖、打包入口、Node 资源定位和协议 schema。不能只删除 `main.mjs` 就称迁移完成。原生模块/命令遵循同一能力接口；Windows 的 `/usr/bin/ssh` 路径、Mac helper 和系统安全存储差异单独适配，Linux测试不能替代 Windows/Mac 验收。

阶段 D 同时验证 DSH Client 插件与 `hub-ui` 的 React external/版本、CSS 作用域、导航挂载和失败卸载。手机先复用组件、DTO 和业务 API，不强行套桌面布局；浏览器没有原生设备能力时明确报告不可用。

## 9. 数据切换与回退

这是本项目现有状态的所有权迁移，不涉及已明确不做的旧 Pi 客户端数据迁入。

- 保留 DSH_HOME、profile、会话 nativeId、设备 instance、请求/执行身份以及当前目录映射；不通过“新装一个空 profile”绕过兼容问题。
- 切换前停止接单并确认无活动任务，制作 SQLite 一致性备份（考虑 WAL）、DSH/profile 与业务账本的受保护备份，校验可恢复。凭据仍留系统安全存储。
- 初期复用现有 SQLite 格式和数据位置，插件取得单一写入所有权。不要直接复用 `Store` 构造函数做只读导入：它会把 queued/running 任务写成 interrupted。
- 列出 `desktop.sqlite`、`dogo-commands.json`、`dogo-sessions.json`、账号设备作用域、同步游标和文件基线逐项去向。每次转换有版本标记，可重复运行且不会再次执行任务。
- 旧只读会话保持权限；旧任务历史保留可读。停用旧创建入口前提供原生新会话入口，明确旧任务与原生会话的区别。
- 迁移前后校验会话/任务数、文件摘要、身份映射、未回传结果和客户端草稿；旧/新消费者不得同时运行。
- 回退先停止新消费者并确认在途执行结果，再使用兼容版本读取现态；如果有存储升级且旧版不能读取，停止自动回退，需迁移工具或明确的恢复步骤。
- 不能简单恢复旧快照后重放新版本已完成的远端任务；回退必须核对服务器领取/终态与本地回执，未知状态保留待核对。

## 10. 必需验收与本轮证据

改版交付时必须覆盖：

1. 无中转账号时本地 DSH 可用；配置 DSH 原生模型后不依赖旧 `settings.model`。
2. 手机创建/续聊同一 nativeId；不同会话并发、同会话排队与取消行为符合 DSH 规则。
3. 领取响应丢失、提交响应丢失、提交前后崩溃、结果回传失败均不重复执行。
4. 手机/本机同时回答审批时只有一次有效结果；断线后过期审批不能继续放行。
5. 撤销项目、账号退出、设备撤销和插件卸载都停止相应新任务；验证在途操作的取消及未知结果。
6. 附件摘要、大小限制、先落盘后回执；记忆三方冲突、CAS、独立维护会话、单次尝试不回归。
7. 插件的后台异常不导致虚假成功；进程强杀、插件重启、profile 变更后正确恢复或明确失败。
8. UI 插件导航、重连、草稿、React 打包和原生桥权限；Mac 与 Windows 分别实机验收。
9. 旧数据升级/兼容、单写入者锁、回退后的远端状态核对；安装包包含插件、上游依赖和客户端产物。

本轮实际执行：

- 现有定向测试 5/5 通过，0 失败、0 跳过：`hub.test.mjs`、`native-turns.test.mjs`、`hub-relay.test.mjs`、`memory.test.mjs`。其中真实 DSH 连接合成本地模型；部分 relay 测试使用夹具，未连接生产服务。
- 仓库外独立探针两次启动通过：直接运行官方 CLI 的隔离 profile，不实例化 DogO Engine/runtime；验证无会话后台计时、自定义鉴权 API、sessionController/storageDomain 注入、业务文件跨重启，以及 effect 清理。第一次 SIGTERM，第二次 stdin 结束触发 appExit。
- 探针初版的 dispose 事件登记及重复使用 profile 初始化参数失败已分别定位修正；最终重跑通过，不能把此前失败当作 DSH 不支持插件生命周期。
- 尚未执行：DogO Client 插件页面原型、新版协作模块、Mac/Windows 实机、Android 本机 DSH、真实模型与生产数据迁移。上述均不属于已完成的改版。

本机评估脚本与输出位于 `/workspace/dogo-assessment/`，不加入应用源码；临时 profile 已清理。本轮文档链接/布局检查单独执行，不替代功能验收。

## 11. 评估依据

DogO 代码入口：

- [Host 挂载（已迁移）](../packages/dsh-plugin/src/host/mount.mjs)、[HostServices（已迁移）](../packages/dsh-plugin/src/host/services.mjs)、[DSH 启动](../apps/desktop/src/host/dsh.mjs)。
- [Hub](../packages/dsh-plugin/src/host/hub.mjs)、[记忆](../packages/dsh-plugin/src/host/memory.mjs)、[能力](../apps/desktop/src/native/capabilities.mjs)、[存储](../packages/dsh-plugin/src/host/store.mjs)。
- [现有 DSH 插件](../packages/dsh-plugin/src/index.mjs)、[原生会话桥](../packages/dsh-plugin/src/sessions.mjs)。
- [桌面主进程](../apps/desktop/src/main.mjs)、[Mac 打包](../apps/desktop/scripts/package-mac.mjs)、[手机 Agent](../apps/mobile/src/agent.ts)。

本地安装的上游包 README / `lib/types` / 必要实现：`@deepseek-ai/dsh`（profile/启动）、`@deepseek-ai/cordis`（effect/fiber）、`dsh-api-session-controller`、`dsh-client-connection`、`dsh-api-gateway`、`dsh-host-webserver`、`dsh-webhook`、`dsh-storage`、`dsh-storage-domain`、`dsh-client-modules`、`dsh-client-ui-layout`、`dsh-client-ui-sidebar`、`dsh-client-ui-plugin-manager`。后续 DSH 升级必须重新做兼容检查，本文不是跨版本稳定性承诺。
