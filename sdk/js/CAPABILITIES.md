# C# / JS 宿主能力对照

验收基准为当前 `IPluginServices`、`IPlatformTerminal`、插件加载器及 ForwardAPI 实际使用的能力。不把 C# DLL 的任意 CLR/文件/进程访问算作应暴露的脚本权限。

| C# 能力 | JS API / 声明 | 状态 |
| --- | --- | --- |
| 包加载、启停、失败保留旧版本、流排空 | JintPackageLoader → 同一 LoadedPlugin / Catalog | 已实现 |
| 一个包的多个平台、独立策略、probe/模型 TTL | `platforms`、平台 hooks/policy/probeEndpoint | 已实现 |
| start/stop、models、credential validation、page provider | 命名导出、`getMainPage` 或静态 page | 已实现 |
| 普通完成、工具、推理、签名、usage | completion / `ctx.reply.completion` | 已实现 |
| SSE 转换、raw 字节、非流式聚合与最终写出 | mappedStream / raw / finalizer | 已实现 |
| 原始协议请求/未知字段/大整数 | `originalBodyRef` + `originalJson` 原生编辑 | 已实现 |
| 账号 CRUD、六种凭证、状态动作 | `ctx.accounts`，插件归属与字段权限检查 | 已实现 |
| 并发安全刷新、不覆盖冷却 | credential version + 原生字段 CAS + 独立回调 Engine | 已实现 |
| 账号筛选、权重、积分到期优先 | `selectAccounts` 批量偏好 + preferredExpiry/weight | 已实现 |
| 业务重试与资源动作 | 相同 `PluginAttemptDecision`，真实传输证据校验 | 已实现 |
| 独立代理池和可选 Polly 传输重试 | `http.request/open` 的 pool 路由 | 已实现 |
| 固定代理客户端、显式直连 | `http.createClient`，调用内句柄 | 已实现 |
| JSON/文本/二进制/表单 HTTP | body/bodyText/bodyBase64/form，read/drain | 已实现 |
| 重定向 | 逐跳授权、跨 origin 限 GET/HEAD 并清理敏感头；带正文 GET/HEAD 限制见 API 手册 | 已实现 |
| ForwardAPI 动态站点 | 管理端点明确 origin 批准，SQLite 持久化 | 已实现 |
| 本版本内存/插件共享状态 | state.local / state.shared，JSON 与字符串 | 已实现 |
| 原子增量、写入缺失键、CAS、到期查询 | 两种状态后端共用接口；Redis 用 Lua 原子操作 | 已实现 |
| Cron / 手动任务锁 / 账号任务日志 | tasks.run / tasks.writeLog，同名后台 job 仍走 task invoker | 已实现 |
| 长后台工作、去重、进度、状态、取消 | jobs 声明及 ctx.jobs，版本持有与退出等待 | 已实现 |
| 结构化诊断与关联信息 | log.write，凭据脱敏 | 已实现 |
| 哈希、HMAC、随机 ID、编码、精确十进制、URL | 有界同步工具，不依赖 Node | 已实现 |
| TS/JS 多模块开发与包输出 | init/build CLI、esbuild 单 ESM bundle、导出/路径检查 | 已实现 |

## 有意保留的边界

- 管理端点与 C# 一样由当前 Catalog 统一要求管理员会话/CSRF；`Internal` 不对外暴露。不会仅因脚本声明 Anonymous 就开放公网管理操作。
- JS 没有 Service Locator，不暴露 HttpContext/IServiceProvider/CLR；同步工具不是任意 .NET 反射入口。
- 账号选择不能直接 I/O 或写状态，mapper 不能异步 I/O；这些是边界，不是占位实现。
- 同步刷新锁是本机锁，凭证 CAS 是数据库级条件更新；共享状态依赖 Redis。没有跨实例“只刷新一次”或任务跨重启恢复的虚假保证。
- HTTP 工厂不按业务状态码重试/换账号，无代理不悄悄直连；未加默认 HttpClient retry/hedging。
- 当前移植的公开业务插件为 js-forwardapi。Node 模拟只验证声明范围，不替代实际 Jint/上游验收，仓库内不添加 C# 项目。

## 回归入口

- `JsCapabilityParityTests`：真实 Jint + SQLite 的 CRUD/CAS、独立刷新回调、共享状态、精度/二进制/固定代理、任务、多平台、动态网络授权及权限拒绝。
- `JsStreamingTests` / `StreamLifecycleTests` / `PluginStreamingExecutionTests`：流资源、取消、drain、工具/推理/usage 及完整写出。
- `sdk/js/build.test.mjs`：脚手架、TS 打包、不执行 hook、拒绝 Node 运行时与源目录覆盖。
- `sdk/js/check-docs.mjs`：SDK 本地链接目标、中文类型注释、教学源码/清单类型和页面脚本语法；不执行插件、不替代 Jint。
- `plugins/js-forwardapi/forwardapi.test.mjs`：Node 模拟账号、CAS、HTTP/source、job 和精确十进制参考运算。

### 分仓后的验证入口

- 本仓库运行 SDK 类型、文档和 Node/esbuild 测试；构建测试不执行第三方 hook，教程逻辑使用 mock ctx。
- 真实 Jint、HTTP、状态、SSE 与生命周期测试在 Router2API 仓库的 tests/Router.Tests。
- C# ForwardAPI 回归在 Rouer-Plugins-Csharp，集成测试通过 test.ps1 显式指定宿主。
- 只有实际执行的命令才记为通过；静态检查、构建、真实运行时、浏览器和上游账号验收不能互相替代。
- 发布不包含测试账号，也不自动连接真实上游、提交、安装或推送。
