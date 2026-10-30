# DSH Remote 复用评估（2026-10-26）

结论：**可以复用，适合作为设备连接插件的基础；不是安装后直接接入现有 DogO 的成品。** 推荐继续使用官方 DSH，保留备忘录、设备连接两个业务插件。设备插件优先吸收上游已经验证的原生会话桥接；DogO 继续拥有账户、设备、备忘录和持久投递队列。

本次为隔离评估，未把上游整套产品并入 DogO，未实现可交付的 DogO 设备插件，也未修改线上服务或用户的 DSH 配置。

## 版本和隔离

| 项目 | 本次实际使用 |
| --- | --- |
| 评估分支 | `codex/evaluate-dsh-remote` |
| 基线 | `067e2d6`：只在评估分支保存当前未提交的新版源码快照 |
| 上游 | [`liguobao/ds-harness-remote` v0.5.18](https://github.com/liguobao/ds-harness-remote/tree/fac5e6005b6b747889ef01193a64601bb14f53ad)，MIT |
| 上游提交 | `fac5e6005b6b747889ef01193a64601bb14f53ad` |
| 实际 Host | 已安装官方 DSH `0.2.0-rc.2` 的 CLI / Web profile，Electron Node `24.18.1` |
| 上游开发依赖 | DSH `0.2.1-rc.1`；本次另行验证了已安装 `0.2.0-rc.2`，未升级应用 |
| 测试工具 | Node `24.19.0`、pnpm `9.15.4`；Python `3.13.17`、uv `0.13.5` |
| 本地端口 | 上游 relay `127.0.0.1:18180`；DSH `127.0.0.1:18181`；DogO 使用随机回环端口 |
| 配置和数据 | 独立 `DSH_HOME`、临时 DogO 数据库、随机测试账户；没有读取生产模型凭据 |

正式发布包校验：

- `ds-harness-remote-0.5.18.tgz` SHA-256：`b32ef9454e387732de7d3c7a625bcf465b4353b62401226df33b355dc3face13`
- `dsh-remote-android-v0.5.18.apk` SHA-256：`8ad9411079e1d45d84f51c6bf280767e29c9a74afc2a26d0033dd4fa2110fbaf`

源码测试和实际加载正式发布包分开进行。上游 checkout 在构建、测试后保持干净，没有修改测试或放宽断言。`--ignore-scripts` 用于依赖安装；本次主链路强制 relay，不依赖原生 WebRTC 安装脚本。

## 实测结果

| 验证 | 结果与边界 |
| --- | --- |
| DogO 后端回归 | **38/38 通过**，包括真实 HTTP / WebSocket / MCP 与进程重启测试 |
| 上游全套测试 | 最终串行执行 **794/794 通过**，含插件 407、Android 195、server 12；其余协议/加密/传输等合计 180 |
| 类型检查 / 生产构建 / bundle 校验 | 全部通过；生产构建使用 `--workspace-concurrency=1` |
| 发布插件加载 | 实际官方 DSH `0.2.0-rc.2` 加载、登录本地自托管 relay、上线成功 |
| 加密 relay | 使用真实上游 server、Noise 客户端和发布插件 Host，建立会话通道；无 P2P 依赖 |
| 原生会话 | 经 relay 列表、创建、选模型、发送、读取原生历史、在同一会话继续发送均通过 |
| 客户端断开 | 发出指令后关闭客户端连接，DSH 继续完成；重新连接可读取完整测试回复 |
| 重复请求 | 重连后重发相同 native `requestId`，测试模型只运行一次 |
| 撤销设备 | 撤销后已连接客户端不能继续调用原生会话接口 |
| DogO 离线投递 | B 未连接时保存备忘录；DogO 进程退出、重启后，由真实 WebSocket 收到同一指令并创建真实 DSH 会话 |
| ACK 丢失 | 故意不回执并重启 DogO；再次投递复用本地绑定与 native `requestId`，执行一次，回填真实 `native_session_id` |
| DSH 自身重启 | 重启整个隔离 DSH 进程后再次重放上述 prompt，执行计数仍为 1 |
| Android 发布包界面 | API 35 ARM64 模拟器通过本地 `adb reverse` 登录自托管 relay、信任设备、创建工作区与会话、发送 prompt；熄屏后 Host 完成，亮屏恢复可见完整回复，截图已检查 |
| 会话不落中转服务器 | relay 状态文件只出现账户/设备/令牌等字段，测试会话标记未出现在持久文件中；这不是全面安全审计 |
| 直接替换 DogO 地址 | **不兼容**：上游 `/api/v1/auth/login` 在当前 DogO 返回 404；鉴权、设备注册和连接协议均需适配 |

模型部分使用 `fixture-model.mjs` 提供确定性流式回复；DSH 的会话、Agent 执行循环、请求去重、持久化和 relay 均为真实实现。没有验证商业模型服务、复杂工具调用或用户个人任务。

首次批量测试出现两个 WebRTC 协商 8 秒超时，结果为 792/794；单独复测相关文件 9/9 通过，再完整串行复跑 794/794。**保留为间歇超时记录，不能解释为已定位或修复。** 首次还有嵌套命令误用全局 pnpm 11 的环境错误，固定 PATH 为项目要求的 pnpm 9 后消除。

最后一轮本机 relay 原生列表调用 20 次：中位数约 **2.99 ms**，P95（nearest rank）约 **5.48 ms**。单次静息快照 relay RSS 约 **56 MiB**，隔离 DSH 约 **86 MiB**；这是 macOS 本地小样本，不是弱配置服务器容量承诺，不能推断公网时延和并发上限。

机器可读探针结果见 [results.json](results.json)。原始日志和临时凭据留在仓库外缓存，不进入提交。

## 怎样复用

| 部分 | 建议 |
| --- | --- |
| 备忘录插件 | 单独实现 UI 与 MCP/工具入口，调用现有 DogO 业务接口；上游没有这一业务 |
| DSH 会话桥接 | 重点复用 `harness-remote-bridge`、`typert-gateway-switch`、`remote-typert-gateway` 及其测试；已经证实可触达当前安装版原生会话 |
| 设备插件 | 在桥接之外增加 DogO 登录/续期、`/api/device/connect` 消费与持久绑定、ACK；本次脚本验证了关键流程，但尚不是插件实现 |
| relay / 加密协议 | 可复用设计与两端实现；若保留其帧协议，FastAPI 要补对应在线设备路由和转发，而不是改个 URL 即可。加密库与协议的版本需锁定 |
| 上游 Node 服务 | 用作测试参照，不替换已经选定的 Python/FastAPI 业务后端；避免引入第二套长期账户和设备身份 |
| Android | 上游是 React Native/Expo，当前 DogO 是 Java/原生 Views，不能作为现有 Android 工程的即插即用模块。可参考会话交互和协议；整合 UI 需要明确选择并评估体积与维护成本 |
| P2P、TURN、Codex/ACP、终端等 | 当前不纳入 DogO 范围，评估主链路关闭，保留原有“小目标”边界 |

两条通路应保持职责清晰：

```text
备忘录 / 指令：Android → DogO FastAPI → SQLite 投递 → B 的设备插件 → B 的 DSH
在线会话：    Android / A → DogO 认证中转 → B 的会话桥接 → B 的 DSH
```

同一个 DSH 会话始终由 B 拥有。服务器保存备忘录和投递关联，在线会话内容由 B 提供，不新增完整服务器会话副本。

Android 实测还发现：上游先展示工作区，单纯给 `session/create` 传 `cwd` 不会自动建立该工作区入口。正式设备插件需要选定默认工作区，或使用明确配置的项目→工作区映射。备忘录项目名是业务文本，不能直接当作电脑目录；本次探针证明会话执行，并未实现这个产品映射。

## 取舍与后续边界

最省短期开发的是直接采用上游插件、Node server 和 Android App，代价是与现有 DogO 账户、备忘录、FastAPI 和 Android 实现形成两套体系。当前更合理的是**复用桥接与协议、保留 DogO 业务边界**，而非整体搬入全部上游功能。

本次确认 native `session/create` 支持指定会话 ID，`session/prompt` 支持 `requestId`，对选定故障窗口的去重可跨 DSH 重启。仍需在正式设备插件中设计“建立会话—保存本地绑定—提交 prompt—ACK”的顺序；**这不是所有崩溃窗口下的 exactly-once 证明**，尤其创建后落盘前、提交结果未知、工具副作用和撤销竞态未全部覆盖。

DSH 的桥接依赖具体接口形状。首次探针以空 args 调 `session/list` 被真实 Host 拒绝：当前安装版要求 `_request` 字段，改为符合原生 descriptor 的请求后通过。这是探针修正，也说明不能把“插件能加载”当作所有版本完全兼容。

待验证：真实手机公网 HTTPS、蜂窝/Wi-Fi 切换与系统杀进程、完整远端 UI 兼容矩阵、真实模型/工具/审批、大附件、服务器网络中断恢复、TLS 运维、压力与长时间稳定性，以及全部投递崩溃窗口。模拟器熄屏测试不代表真实手机厂商后台限制已经通过。

## 复跑

仅在独立缓存目录操作。不要将测试 profile 或测试模型安装进个人 DSH 配置。以下命令中 `EVAL_ROOT` 是本评估工作树的绝对路径，安装的官方 DSH 路径按本机默认位置。

```sh
export EVAL_ROOT=<project-directory>
export EVAL_CACHE="$HOME/.cache/dogo-remote-eval-repro"
export EVAL_UPSTREAM="$EVAL_CACHE/ds-harness-remote"
mkdir -p "$EVAL_CACHE"
git clone --depth 1 --branch v0.5.18 https://github.com/liguobao/ds-harness-remote.git "$EVAL_UPSTREAM"
cd "$EVAL_UPSTREAM"
# 在 PATH 中准备 pnpm 9.15.4 和 Node；不要让嵌套 pnpm 使用另一主版本。
pnpm install --frozen-lockfile --ignore-scripts
pnpm --filter './packages/**' -r build
pnpm -r check
pnpm --workspace-concurrency=1 -r test
NODE_ENV=production pnpm --workspace-concurrency=1 -r build
node scripts/verify-dsh-plugin.mjs
```

下载上述正式插件 tgz 并校验 SHA-256 后：

```sh
export DSH_HOME="$EVAL_CACHE/dsh-home"
DSH_CLI='/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh'
"$DSH_CLI" --profile dogo-eval --from-default-profile web --dump-config > "$EVAL_CACHE/dsh-config.yml"
"$DSH_CLI" plugin --profile dogo-eval add "$EVAL_CACHE/plugin-0.5.18.tgz" --ignore-scripts
python3 "$EVAL_ROOT/evaluations/dsh-remote/prepare-profile.py"
```

分别在两个终端运行，保持环境变量一致：

```sh
node --import "$EVAL_UPSTREAM/node_modules/tsx/dist/loader.mjs" "$EVAL_ROOT/evaluations/dsh-remote/relay-fixture.mjs"
"$DSH_CLI" --profile dogo-eval --no-open --host 127.0.0.1 --port 18181 > "$EVAL_CACHE/dsh-host.log" 2>&1
```

Host 就绪后，在第三个终端执行：

```sh
export EVAL_DSH_LOG="$EVAL_CACHE/dsh-host.log"
node "$EVAL_ROOT/evaluations/dsh-remote/authorize-host.mjs"
node --import "$EVAL_UPSTREAM/node_modules/tsx/dist/loader.mjs" "$EVAL_ROOT/evaluations/dsh-remote/probe-relay.mjs"
cd "$EVAL_ROOT/server"
uv sync --frozen
uv run pytest -q
uv run python ../evaluations/dsh-remote/probe_dogo_queue.py
# 停止并重新启动上述隔离 DSH（保留相同 DSH_HOME）；就绪后：
uv run python ../evaluations/dsh-remote/probe_native_replay.py
```

探针只保存合成会话和结果；`probe-relay` 最后会撤销自己的测试客户端身份。上述固定端口、官方安装路径与 native descriptor 适用于本次环境；冲突时修改所有相应测试配置，不接入个人现有运行进程。

Android 人工验收：在隔离模拟器安装已校验的发布 APK，将 `tcp:18180` 反向映射至本机同端口；应用 More → Switch server 保存 `http://127.0.0.1:18180`，再次打开核对地址后登录测试账户。信任 Host，创建指向测试缓存目录的工作区，使用 Evaluation fixture 模型发送 `continue-<UUID>`。发送后熄屏，再唤醒检查 `EVAL_REPLY:continue-<UUID>`。这个步骤不连接生产账号，不代表公网部署。测试结束应关闭上述两个服务及测试模拟器；缓存包含测试凭据，勿提交或公开。
