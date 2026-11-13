# Android 最小客户端

`android/` 使用 Java 17 和 Android 原生 Views，提供连接服务、登录、查看及禁用设备、退出登录；远程会话界面尚未实现。旧备忘录界面及投递、定时、同步功能已移除。

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

Android 仪器测试只允许模拟器，验证首次启动清理旧草稿并保留账户设置。具体验证结果和真实设备状态见 [STATUS.md](../STATUS.md)。
