# @dogo/desktop

DogO Mac 0.4.0 / Electron 44.7.2：加载共享 web 外壳，以隔离桥接连接独立 Node runtime；独立视图承载完整上游 DSH 工作区。当前安装/部署状态以 STATUS 为准。
不维护第二套业务数据库，不向页面开放 Node、任意 shell 或目录路径调用。

## 安装版与新版跨端入口

本机安装位置：`~/Applications/DogO.app`。包内含 Node 24 和上游 DSH，可脱离仓库运行；与开发版共用原有用户数据和配对。仅本机 ad-hoc 签名，未公证、未做公开分发或自动更新。
本地重新打包会改变签名，macOS 可能再次要求访问原有配对凭据；请只在系统钥匙串弹窗自行确认，不要分享密码。未确认前可能停在启动过程，不能视为已经上线。

默认「工作区」直接在 DogO 窗口内显示同一个 DSH 实例，无需外部浏览器，也无需先配对中转。原生会话、工具过程、模型选择和插件页面沿用上游 UI，不做 DOM/CSS 注入或私有路由适配。切到「资料箱 / 设置」不会销毁页面或中断执行。
设置集中无人值守授权、项目文件夹登记、专用个人记忆目录同步、配对和系统登录项。旧任务与本地模型连接参数在「高级与兼容入口」，只收拢入口，不删除/迁移数据；跨设备回执亦保留。完整退出停止接单，关闭窗口继续运行；没有独立守护进程。

原生视图使用独立持久 session、稳定回环端口、沙箱与 context isolation，不带 DogO preload 或 Node 权限。文字草稿可跨完整退出恢复；未发送图片附件受上游限制不保证保留。仅当前回环 origin 可导航，外部 HTTPS 链接（例如订阅登录）会询问是否交给浏览器；file/javascript/自定义协议与跨站重定向拒绝，不绕过系统授权。

上游保持 `0.2.0-rc.2`，不自动更新运行中的 DSH。后续升级只替换锁定依赖并执行桥接回归和原生页面冒烟；无需追随 UI 元素变化，但 API/认证变化仍须验证。使用 Electron 官方 [WebContentsView](https://www.electronjs.org/docs/latest/api/web-contents-view) 与[安全隔离建议](https://www.electronjs.org/docs/latest/tutorial/security)。

Mac 个人记忆目录为 `~/Library/Application Support/DogO/local/personal-memory`。只扫描这里，冲突先由独立 DSH 会话尝试一次，不确定则保留双方供手机设置人工处理。开启开关不意味着读取所有个人目录。

本地打包：`node apps/desktop/scripts/package-mac.mjs`。脚本核对官方 Node 校验和，并在安装目录检查 runtime 依赖可加载后签名。产物在 `release/`，不提交 Git。

运行 `pnpm test:desktop` 验证视图生命周期、URL/IPC 参数、权限和恢复逻辑。`pnpm --filter @dogo/desktop acceptance` 启动隔离的临时数据目录与合成模型，不连接中转或用户模型，不读取旧凭据；用于原生界面验收。该测试结束后正常退出测试窗口即可，临时测试记录保留供检查。

## 启动

仓库根目录运行（Node.js 24+，pnpm 11.22.0）：

```sh
pnpm install --frozen-lockfile
node apps/desktop/node_modules/electron/install.js
pnpm dev:desktop
```

Electron 的显式安装命令下载官方二进制并校验摘要；不是安装到系统 Applications。
启动命令先构建界面，再启动原生窗口与 runtime；无需启动 Vite 或服务器。
模型未配置时也能选择一个文件夹，运行真实的目录检查。

## 兼容保留的本机任务 / 旧远端收件

- 工作台、任务搜索/筛选、结果、执行记录、复制、停止和分析任务的后续对话。
- 原生文件夹选择后授予本次启动内的只读访问权。重启后需重新选择目录。
- 设置中填写本机 OpenAI 兼容接口和实际模型 ID；默认 32768 上下文、4096 最大输出。
- 关闭窗口或 Cmd+W：隐藏窗口，主进程与 runtime 继续；托盘/Dock 可重新打开。
- Cmd+Q/菜单退出：有任务时确认，停止任务后退出。异常退出后标记中断，不自动重跑。
- 结果通知仅展示通用提示，不在通知中泄露任务内容；系统可能限制开发版通知。
- 设置导入本机 `mac.json`（Windows 预留 `win.json`）；原生侧校验设备身份，用系统安全存储加密，不把令牌交给页面。
- “远端收件”每 5 秒刷新；选择只读检查或 DSH 分析并授权目录，点击“确认执行并回传”。没有模型时可用只读检查。
- “进入内置工作区”：回到同一个 DSH 原生页面管理插件、模型登录及普通会话，不另开浏览器。旧版任务保持只读授权；新版正常会话不沿用此限制。
- 持久记录领取身份，连接恢复后重试结果回传，不重跑任务；任务详情区分等待回传与服务器确认回传。
- 当前服务器只配置 Mac/手机，Windows 尚未部署；手机关闭不取消 Mac 已领取的任务。

数据默认位于 Electron 的 `userData/local`，macOS 通常为 `~/Library/Application Support/DogO/local`。
测试可显式设置 `DOGO_DATA_DIR` 使用隔离目录。SQLite 保存任务与配置，`dsh/sessions` 保存 DSH 会话；旧 `pi/sessions` 保留，不再续聊。
开发版需要本机 Node，安装版自带 Node。尚无公证、DMG、自动更新或 Windows 验证。

中转地址由设备文件绑定；不要将 mac.json 发给其他人或放进仓库。配对与服务器运维见 [部署说明](../others/services/DEPLOYMENT.md)。
已安装的订阅插件需要独立登录；工作目录记忆不是个人全局记忆。真实长上下文、模型合并质量和 Windows 需专项验收，详见 [STATUS](../../STATUS.md)。

## 0.4.0 设置与设备能力

设置提供个人账号初始化/登录/退出、恢复码、设备授权与撤销；密码由用户填写，恢复码需用户私下保管。首次初始化由已配对 Mac 发起，不自动删除旧配对。可显式使旧凭据失效；账号恢复会撤销旧会话。退出账号停止远程接单，不删除本地工作区。

「检查准备状态」只检查模型列表、DSH/插件、系统权限与策略，不调用模型生成，不自动申请系统授权。项目可修改名称/概要和公开/执行授权；撤销会阻止排队任务、请求停止相应远程执行，不停止用户从 DSH 原生启动的无关工作。

DogO 工具开关默认关闭，开启后可供 DSH 薄插件使用：

- 电脑操作：主屏幕截图、点击、输入、按键、滚动、切换应用；需要 macOS 屏幕录制/辅助功能授权。要让模型理解截图还需支持图像的模型；本地文本 27B 不自动具备视觉能力。
- Codex 编码委派：本机 Codex CLI 现有登录，在已登记且允许执行的项目中运行 `codex exec --json`；使用 workspace-write 沙箱和非交互限制，无法在无人值守中升级权限。回收进度、最终结果、测试输出和中断状态，不把断线当成功。
- SSH：只接受用户在本机配置的 Host 别名，复用本机 SSH 密钥/agent 与已确认的 known_hosts。严格主机密钥检查，不自动接受新主机、不自动重试有副作用的远端命令。

这些开关只约束 DogO 能力工具；DSH 自身的终端/文件工具遵循上游权限。执行停止会终止本机受管子进程，但远端 SSH 命令已产生的副作用仍须核对。合成验收脚本见 runtime/scripts/accept-codex.mjs、accept-ssh.mjs 和 desktop/scripts/accept-computer.mjs，必须显式 `--run`，不扫描个人文件。
