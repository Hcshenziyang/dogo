# DogO Android

Android 0.4.0：React + Capacitor 8 本地资源，不依赖电脑上的 Vite 服务。
新版入口「任务 / 资料箱 / 对话 / 设置」；手机明确发送 → 已授权且运行中的 Mac 自动执行 → 同会话返回结果。「对话」是在手机前台独立运行的轻量 Agent，不依赖 Mac 在线，也不是 DSH Android。旧工作台、数据和配对保留在设置的兼容入口。发行/部署进度见 STATUS。

## 新版能力

- 接续原设备的原生 DSH 会话；分页正文、任务停止、提问/审批、设备与项目基本信息刷新。
- 任务及资料均支持最多 4 个、总计 8 MiB 附件，独立分块上传与摘要验证、封存后才执行；支持下载导出。资料不自动执行，可标为已读/已处理/归档并关联任务。
- 草稿、附件、会话续聊草稿及待发请求先原子落盘；未确认发送使用同一 requestId 重试。缓存按服务地址与设备隔离。
- 设置内启用个人记忆同步：应用私有普通文件目录，md/txt/json；可手动同步、编辑/重命名/删除、分页查看旧版本、恢复/导出及处理未决冲突。不会读取手机其他目录。
- 可开启原生后台消息连接：`remoteMessaging` 前台服务 + 持久 SSE 游标，系统通知提示完成、失败、待确认和人工记忆冲突。需要 Android 通知权限，通知栏保留连接提示；不在锁屏展示正文。
- 这是用户开启的长连接，不是 FCM/APNs。强制停止、厂商省电策略或系统回收可能中断；重新打开补收，不能保证关机/被强停时仍唤醒。

平台依据：[remoteMessaging 服务类型](https://developer.android.com/develop/background-work/services/fgs/service-types#remote-messaging)、[通知运行时权限](https://developer.android.com/develop/ui/compose/notifications/notification-permission)。

## 手机独立 Agent 与账号

设置 → 手机模型与工具：填 HTTPS OpenAI-compatible Base URL（如供应商给出的 `/v1`）、模型 ID 和 API Key。密钥进入 Android Keystore 加密文件，已保存密钥不会回传网页、模型、日志或记忆同步；更换地址不会带走旧密钥。配置前不会发送聊天内容；配置后内容会发给所选供应商。

AI SDK 负责工具循环。内置工具可查看设备/项目、明确委派桌面任务或续聊、投递资料、读取/写入个人记忆；每次工具调用都先在手机确认，不因模型建议自动授权。外部 MCP 仅支持 HTTPS Streamable HTTP 请求/响应（可选 Bearer），不支持 stdio、OAuth、旧 SSE 或持续后台订阅。Skill 为用户明确启用的文本指令，不是可执行插件。

每轮上限 8 步、5 分钟，单次模型输出 4096 token；达到限制显示未完成。长对话生成摘要时保留完整历史，仍可能受模型自身上下文上限限制。会话/草稿与工具审批先持久保存，意外退出不重放执行；可导出全部本地对话或单独删除会话。应用退到后台停止手机推理，已经委派给 Mac 的任务继续。

手机可单独选择参与记忆冲突分析，默认关闭。须同时开启本机同步、配置模型并获服务端维护策略允许，只在前台且无用户对话运行时尝试一次；会将冲突文本发给所选模型，失败或中断转人工。

账号设置支持登录、退出、设备撤销和授权管理。首次 owner 初始化必须在已配对的 Mac 完成，密码与恢复码由用户自行处理；旧配对失效需明确操作。网页使用同源 Cookie，原生使用安全存储会话。传输加密不是端到端加密，服务器管理员可读已同步内容。

## 兼容旧工作台

- 收件箱 / 任务 / 设置；记忆不单独展示。
- 本地待发送任务、目标信箱、自动保存草稿、搜索、筛选、未读状态。
- 任务与草稿在重启后恢复；撤回未发送任务保留历史，不伪装为远端取消。
- 独立演示沙盒：接单、审批、结果返回和阅读；不污染真实待发送任务。
- 原生复制与系统分享、Android 返回键、键盘与安全区域适配。
- 设置导入 phone 设备文件；Android Keystore 加密保存令牌，原生 HTTPS 请求不向 WebView 暴露凭据。
- 每个任务明确发送；服务响应丢失时保留目标与 requestId，重试不重复建单，不虚报已撤回。
- 前台每 10 秒/回到应用时刷新结果，失败保留原记录；一个任务异常不阻止其他结果更新。
- 信箱路径可预配置，同步入口保留。实际服务器地址由设备文件绑定，单独修改预配置不会切换凭据。

Android 的 DogoStorePlugin 仅暴露固定存储键，使用应用私有文件、AtomicFile、串行写入和落盘检查。
保存失败不更新成功状态；主数据异常尝试上一份备份，均不可恢复时保留原文件并阻止覆盖。
浏览器预览使用 Capacitor Preferences 的本地存储回退，与手机数据不共享。
默认关闭系统云备份和设备数据迁移，不申请通讯录、定位或广泛文件访问；只在用户开启后台通知时申请通知权限。
卸载/清除应用数据会删除本地记录；重要任务可单独分享保存。

## 本地浏览器检查

在仓库根目录运行：

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm dev:mobile
pnpm build:mobile
pnpm test:mobile
```

访问 http://127.0.0.1:5173 。仅监听电脑回环地址；安装 APK 不需要这个服务。
预览首次打开为空的本地工作台，在设置中进入演示沙盒。

## 构建 APK

需要 Node.js 24+、pnpm 11、JDK 21、Android SDK Platform 36 和 Build Tools 36.0.0。
Android SDK 的许可必须由用户同意；构建脚本不会自动接受许可，也不会修改 shell 配置。

在已接受 SDK 许可并安装 command-line tools 后安装所需组件：

```sh
sdkmanager --sdk_root="$ANDROID_HOME" 'platform-tools' 'platforms;android-36' 'build-tools;36.0.0'
pnpm build:apk
```

脚本优先读 DOGO_JAVA_HOME / JAVA_HOME 及 ANDROID_HOME / ANDROID_SDK_ROOT；
本机默认 JDK 路径为 /opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home，SDK 路径为用户目录下 Library/Android/sdk。
其他平台请明确设置路径。脚本执行 Web 构建、Capacitor 同步、Android release 构建/lint 和签名验证。

成功后输出 apps/mobile/release/DogO-0.4.0.apk 与 SHA-256 文件（不提交 Git）。
APK 为本机个人签名的 release 包，不是应用商店发布；没有嵌入开发服务器地址。
首次构建创建用户目录下 .local/share/dogo/android-signing/ 中的签名密钥与密码配置，目录 0700、文件 0600。
请安全备份整个目录，后续更新必须复用签名；丢失密钥会影响覆盖安装。不要上传密钥或密码。

将 APK 传到自己的 Android 手机后打开安装；安装授权由用户在手机完成，不需要为应用授予额外敏感权限。
目标为 Android 7.0/API 24 及以上，需较新的 Android System WebView；具体真机兼容性以验证记录为准。

## 配对与发送

1. 覆盖安装同签名的 0.4.0 APK，不要卸载旧版（卸载会删除本地记录）。
2. 私下将 `phone.json` 传到自己的手机；设置 → 任务服务连接 → 导入手机设备凭据。不要导入 `mac.json`。
3. 新版任务页新建 Mac 任务并明确发送；已有会话直接续聊。服务端尚未启用 Windows 信箱。
4. Mac 保持 DogO 运行，并在新版设置开启已配对设备自动执行。手机前台自动读取结果，也可手动刷新。
5. 手机设置按需开启后台消息通知和专用记忆同步。旧配对不需重做；不要把 Mac 文件导入手机。

配对文件含长期设备令牌，不放公开链接、Git 或聊天截图；成功导入后妥善处理手机中的明文副本。
服务端和私有文件位置见 [部署说明](../others/services/DEPLOYMENT.md)。关闭手机不取消 Mac 已领取任务；Mac 关机不能执行。

## 接入点

- src/gateway.ts：TaskGateway.publish/read 与 MemorySyncGateway.sync 接口。当前 unconfiguredGateway 只返回明确的未连接错误。
- src/workspace.ts：稳定 requestId、任务创建时的目标信箱快照、本地 outbox 与独立 demo 数据。
- src/platform.ts / src/relay.ts：受限原生桥、明确发送、远端状态合并与结果回读；浏览器实现拒绝配对和发送。
- Android RelayTransport / DogoRelayPlugin：Keystore、原生文件选择、HTTPS、固定路径 API；无任意代理或 shell。
- 发布输入与现有服务 /v1/tasks 的 requestId/mailbox/title/instructions 对齐；不要把示例记录投递到服务器。
- `HubApp.tsx`、共享 `packages/hub-ui`、原生 `PersonalMemory` 和 `RelayNotifyService` 为新版入口；旧 v1 逻辑留作兼容。

## 验证边界

JS 测试覆盖持久化/重启、并发保存、写入失败、损坏恢复、真实/演示隔离、输入及路径校验。
Android 仪器测试 WorkspaceStorageTest 验证临时文件原子写入；RelayTransportTest 验证安全地址与可选真实 HTTPS 往返。
普通测试不联网。显式执行 scripts/test-relay-android.mjs 才读取私有 phone 文件并向真实服务发送合成任务，需在 Mac 确认合成目录检查；仅允许 DogO_V1_API_36 独立模拟器的 .devtest 包，凭据不进入 APK。
实际构建、签名和真机结果统一记录于 [STATUS](../../STATUS.md)，不要把 Web 构建当成 APK 验证。

`HubIntegrationTest` 是需显式 `dogoLiveV2=yes` 的原生验收：私有 devtest 凭据、合成任务、真实 Mac 续聊、资料接收、后台系统通知与记忆往返。不会把令牌编进测试 APK。真实手机尚需覆盖安装后验收，模拟器结果不替代厂商后台限制测试。

`node apps/mobile/scripts/test-hub-android.mjs --run` 在已安装 debug 与 androidTest 包的 `DogO_V1_API_36` 专用模拟器中执行生产中转验收，要求已配对 Mac 在线。包含 0.4.0 独立分块附件下载、摘要及资料状态检查；仅使用合成内容，完成后清理 devtest 凭据，不触碰 release 应用或真实手机。未提供原生会话/指定记忆夹具参数的两项测试明确跳过。

可使用 `--only roundtrip|attachment|native|memory` 定向运行一项，原生会话与记忆项还必须提供已准备的合成夹具：

- `--only native --native-session <Hub会话UUID>`：先从 Mac 原生 DSH 界面新建仅记住 `NATIVE_827` 代号的合成会话，再传中转 UUID（不是 `session-…` 原生 ID）；不使用个人会话。
- `--only memory --memory-fixture acceptance-<唯一编号>.md`：先在 Mac 专用记忆目录新建该文件并等同步，内容为 `Synthetic Mac memory fixture; not a personal preference.\n`；测试后核对 Mac 收到 `Synthetic Android roundtrip fixture; not a personal preference.\n` 并移除合成文件。这里 `\n` 表示实际换行。

脚本单独报告 `passed` / `skipped`，校验预期通过数；JUnit 的 `OK (N tests)` 可能包含跳过项，不能直接当作 N 项通过。2026-10-19 四项生产场景已分批复验通过，具体证据见 STATUS。

2026-10-16：Release 构建、lint、签名、21 项 JS 测试及 Android 16/API 36 arm64 模拟器安装通过；
3 项原生仪器测试通过，含真实服务 → Mac 人工确认执行 → Android 原生读回及凭据加密。当前界面工具不能识别 SDK 模拟器窗口，
实际原生启动显示、重启保留、返回键、键盘与分享仍需真机或可控模拟器补验。

参考：[Capacitor Android](https://capacitorjs.com/docs/android)、[官方 SDK 安装说明](https://developer.android.com/tools/sdkmanager)。
