# Android 最小客户端

手机首发平台已确认为 Android。工程在 `android/`，使用 Java 17 + Android 原生 Views + HttpURLConnection，没有 Agent、模型配置、MCP Host、WebView 或后台执行服务；应用运行时没有第三方库依赖。测试库只用于测试。

## 当前功能

- 自定义服务器地址、账户登录、手机设备登记、JWT 自动续期、退出；账户由服务端 CLI 创建。
- 备忘录分页、按项目筛选、详情、新建、编辑、追加、删除，保留项目、分类、标签和启用状态。
- 新建备忘录时可选指令与已启用的桌面设备；设备离线时由服务器排队。投递状态随备忘录展示，“已接收”不代表执行完成。
- 设置中查看、禁用设备。接口没有在线状态，“启用”不显示成“在线”。退出不取消远端工作；无法确认服务端退出时，可明确选择只清除本机凭据。
- 每个服务器/账户保留一份当前编辑草稿，必须处理后才开始另一份。输入延迟保存，离开编辑页和应用进入后台时补存；重新打开可继续草稿。列表和详情在线读取，不提供完整离线同步或附件。

创建前将原请求 ID 和完整提交正文写入草稿；结果未知时冻结原提交供重试。修改/追加保留原版本号，冲突时展示服务器内容与本地输入，必须人工核对后再继续，不能自动换版本重发。明确放弃本地草稿不会撤销服务器操作。

已有备忘录的后续编辑不会重新派发其原指令。手机不接入桌面消费者 WebSocket；远程会话界面、DSH 实际执行及跨端完整同步后置。

## 构建

需要 JDK 17、Android SDK（platform-tools、platforms;android-36、build-tools;35.0.0）。Gradle Wrapper 固定 8.14.3 并校验发行包 SHA-256，Android Gradle Plugin 固定 8.13.0。最低 Android 8.0 / API 26，目标 API 36。

```sh
cd mobile/android
# 配置 JAVA_HOME 和 ANDROID_HOME，或用未跟踪的 local.properties 指定 sdk.dir。
./gradlew :app:assembleDebug :app:testDebugUnitTest :app:lintDebug
```

调试包：`android/app/build/outputs/apk/debug/app-debug.apk`，应用名 **DogO Dev**，包名 `app.dogo.mobile.dev`，可与旧版 `app.dogo.mobile` 并存。产物及本机 SDK 路径不纳入 Git。正式发布的签名和分发尚未配置。

Release 只接受 HTTPS 根地址；Debug 允许 HTTP 供本机联调。请求拒绝跳转，不向重定向目标转发凭据。登录密码不持久化，令牌、设备身份及草稿使用 Android Keystore AES-GCM 加密后原子写入应用私有目录，并禁用备份；读写失败不会默默清空原文件。应用级单队列和共享凭据存储保证旋转屏幕时不会出现两个独立刷新流程。

## 联调和测试

单元测试包含真实本地 HTTP 往返、刷新并发/撤销/失败、重定向、设备数组响应及草稿请求/版本保护。普通测试命令会跳过 `LiveApiTest`，启用以下专用临时服务后再运行它：

```sh
# 终端一：仅监听本机，使用临时数据库和固定测试账户，退出时删除。
cd server
uv run python ../mobile/scripts/test_server.py

# 终端二：JVM 与真实 FastAPI 联调
cd mobile/android
./gradlew :app:testDebugUnitTest -Ddogo.apiUrl=http://127.0.0.1:18765 --rerun-tasks

# 使用 Android 模拟器，10.0.2.2:18765 映射上述本机服务。
./gradlew :app:connectedDebugAndroidTest
```

模拟器测试仅连接上述测试服务；不要将固定测试账户用于正式部署。测试覆盖原生界面登录、CRUD/追加、项目筛选、草稿恢复和退出，以及 Keystore 持久化与账户/服务器隔离。当前实际验证结果与尚未验证部分见根目录 `STATUS.md`。真实手机、正式 HTTPS 部署、旧用户数据迁移不包含在本轮联调结论中。

## 代码职责

| 文件 | 职责 |
| --- | --- |
| `MainActivity.java` | 登录、列表、详情、编辑、冲突核对和设备设置 |
| `ApiClient.java` | 普通 HTTP、认证、一次刷新重试、拒绝重定向 |
| `SecureStore.java` | 加密原子存储、设备身份和草稿隔离 |
| `EditorDraft.java` | 原请求与原版本保留，提交结果未知时冻结正文 |
| `DogOApplication.java` | 跨 Activity 生命周期共享队列、客户端和存储 |

首版采用原生 Java，是为了直接承载已有 HTTP 接口，减少工具链和运行时层次。以后若有明确的 iOS 或复杂交互需求，再评估跨平台方案；当前不恢复旧 Capacitor/Agent 工程。
