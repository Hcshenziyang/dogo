# DogO

DogO 的长期方向是个人 AI 伙伴。当前桌面侧保留 DeepSeek Harness 项目与会话，并提供本地知识工作区（Markdown、待办、Canvas）及设备远程访问。

当前组成：

- [DSH 插件](plugins/README.md)：知识工作区与设备远程访问，分别安装。
- [Python 服务](server/README.md)：账户、设备与在线会话中转。
- [Rust 服务](server-rust/README.md)：邀请码注册、账户和设备管理；尚不具备在线会话中转能力。
- [Android 客户端](mobile/README.md)：登录和设备管理；远程会话界面尚未实现。

旧备忘录功能及同步、投递、定时逻辑已经移除。知识工作区本地笔记与旧备忘录是不同数据，继续保留。两种服务使用独立数据库，不互相迁移。实际部署与验证状态见 [STATUS.md](STATUS.md)；[产品边界](PRODUCT.md)、[技术方案](ARCHITECTURE.md) 和 [验证计划](PLAN.md) 中较早的备忘录方案属于历史记录。
