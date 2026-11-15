# Android 最小客户端

`android/` 使用 Java 17 和 Android 原生 Views，支持登录、设备管理，以及查看和续聊电脑上的现有会话。旧备忘录界面及投递、定时、同步功能已移除。

最近会话展示所属电脑和最近消息；对话页展示电脑在线状态、会话是否正在执行及最近 30 条消息。电脑离线或正在执行时可编辑草稿，空闲后才能发送。草稿、最近消息和未确认的发送请求按账户及会话保存在本机加密存储；电脑确认接收后才显示已收到。结果未知时保留原消息与请求编号，重新连接并确认会话空闲后使用同一编号复核。关闭页面或锁屏不会停止电脑上的执行；回到前台会刷新。列表最多读取每台电脑的前三页，状态查询最多检查十页，超出范围时不会假定会话空闲。

首次启动更新后的应用时，会从 Android Keystore 加密的本机状态中删除旧备忘录草稿键；登录凭据、设备身份和连接设置保留。此清理只在对应 Android 安装更新并启动后发生，不会触及知识工作区文件。

## 构建

需要 JDK 17、Android SDK（platform-tools、platforms;android-36、build-tools;35.0.0）；Gradle Wrapper 固定 8.14.3，最低 Android 8.0 / API 26。

```sh
cd mobile/android
# 配置 JAVA_HOME 和 ANDROID_HOME；可在 local.properties 设置 dogo.defaultServer。
./gradlew :app:assembleDebug :app:testDebugUnitTest :app:lintDebug
```

调试包位于 `android/app/build/outputs/apk/debug/app-debug.apk`，应用名 **DogO Dev**，包名 `app.dogo.mobile.dev`。调试包不能覆盖包名为 `app.dogo.mobile` 的正式版；要清理正式版已有数据，需使用与原应用相同包名和签名的更新包。Release 只允许 HTTPS；Debug 可使用 HTTP 联调。请求拒绝重定向；密码不持久化，令牌和设备身份使用 Android Keystore AES-GCM 加密并原子写入应用私有目录。

## 联调和测试

普通单元测试验证认证续期、设备响应、重定向和旧草稿清理。可使用独立临时服务运行真实 HTTP 联调：

```sh
# 终端一：只监听本机，临时数据库和固定测试账户，退出时删除。
cd server
uv run python ../mobile/scripts/test_server.py

# 终端二
cd mobile/android
./gradlew :app:testDebugUnitTest -Ddogo.apiUrl=http://127.0.0.1:18765 --rerun-tasks
./gradlew :app:connectedDebugAndroidTest
```

Android 仪器测试只允许模拟器。远程会话测试需要另行启动仅供测试的 Rust 服务（监听 `127.0.0.1:18789`、使用独立空目录及测试邀请码 `synthetic-invite`），然后运行 `node mobile/android/test-support/remote-fixture.mjs`；它模拟电脑接收后断线、重新连接和去重。未启动该夹具时此测试会跳过。具体验证结果和真实设备状态见 [STATUS.md](../STATUS.md)。
