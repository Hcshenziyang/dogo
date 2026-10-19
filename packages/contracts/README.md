# @dogo/contracts

共享边界校验，不依赖 DSH、Electron、应用或数据库。

- `host`：Host 协议版本、PID/代次握手、RPC envelope、本机能力策略和浏览器方法白名单。
- `pairing`：HTTPS 服务 origin、设备身份及凭据格式。

使用 Zod 对外部输入做运行时校验；具体业务操作继续在拥有数据的模块验证。
