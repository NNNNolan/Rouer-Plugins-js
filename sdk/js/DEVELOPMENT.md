# JS 开发教程：以 js-forwardapi 为完整案例

本教程以 **js-forwardapi** 为主线，覆盖账号录入、模型发现与选号、原始协议/SSE、额度和后台签到。它移植自 C# ForwardAPI，但 JS 仓库不加入任何 C# 测试项目。

入口：[插件说明](../../plugins/js-forwardapi/README.md) · [API](API.md) · [中文类型](index.d.ts) · [宿主流程](../HOST-LIFECYCLE.md) · [AI 工作单](../AI-DEVELOPMENT.md)。

## 1. 三个不同的环境

| 环境 | 能力 |
| --- | --- |
| 开发机 Node | TypeScript、esbuild、Node 模拟测试 |
| 后端 Jint | ECMAScript + ctx，没有 Node/DOM/fetch/CLR |
| 浏览器 iframe | DOM + window.Router2API，没有后端 ctx |

本仓库只包含 JS/TS 插件及 Node 模拟测试，不添加 cs/csproj/sln，不要求宿主源码才能测试。实际运行依赖独立安装的 Router2API，宿主自行负责 Jint/SQLite/生命周期框架回归。

## 2. 从构建开始

仓库根目录，PowerShell 7：

```powershell
npm --prefix sdk/js ci
npm run check
npm test
npm run test:build
npm run build:forwardapi
```

产物是 `plugins/js-forwardapi/dist/js-forwardapi`。esbuild 不执行 hook、不安装插件、不发送上游请求。check 校验类型、清单、中文注释、页面语法、本地文档链接和 JS 仓库语言边界。

```text
plugins/js-forwardapi/
  plugin.json              权限、导出、路由、Cron/job
  src/plugin.ts            公开入口、转发与决策
  src/common.ts            配置、URL、HTTP、脱敏、JSON 工具
  src/accounts.ts          账号、模型发现、允许表、选号
  src/quota.ts             精确额度与 CAS
  src/checkin.ts           登录、Cookie、签到、Cron/job
  ui/index.html            自包含页面
  forwardapi.test.mjs      Node 模拟测试
  dist/js-forwardapi/      构建生成，不提交
```

SDK 名称是 `@router2api/plugin-sdk`，使用本地 file: 依赖，不假定已发布 npm。后端只能 `import type`，真正能力来自 ctx。

## 3. 清单是权限边界

阅读 [plugin.json](../../plugins/js-forwardapi/plugin.json)：

- id/platform=`js-forwardapi`，凭据 Custom。
- 模型 TTL=0，目录来自当前账号允许表。
- HTTP 只授权 direct，与 C# ForwardAPI 直连行为一致。
- origins 初始为空；manageOrigins 允许管理员明确授权，不代表任意出站。
- 批量秘密读取仍需 read + readCredentials。
- 模型最多 3 次 attempt，不叠加 HTTP POST retry。
- 管理路由 AdminSession，page 是自包含 HTML。
- Cron=`js-forwardapi-daily-checkin`，job=`js-forwardapi-checkin`。

顶层只定义函数/常量，不执行 I/O。每次调用使用新 Engine，跨调用数据放 accounts/state/jobs。插件不自动创建匿名账号，未录入账号时不能生成请求。

## 4. 添加账号的完整链路

```text
编辑页面 → 勾选授权 origin → models/discover
 → 校验配置 → 宿主批准精确 origin → GET /v1/models
 → local state 保存 5 分钟目录/时间，键为连接参数指纹
 → 管理员选择模型/端点/权重 → accounts/save
 → 校验服务端目录 → 保存 Custom → 失效模型目录
```

模型、Cron、job 不调用 approveOrigin。填写最终 HTTPS Base URL；跨 origin 跳转仍需对应权限，不能因“转发插件”就授权全网。

保存不信任浏览器伪造的 availableModels。首次保存、连接参数改变、发现过期时重新发现；只允许服务端目录中的模型。已保存账号且连接参数不变，可沿用持久化候选目录。

字段对应 C#：settings、models、modelsConfigured、availableModels、modelsUpdatedAt、quotaSnapshot、quotaUpdatedAt。账号属于 js-forwardapi，不自动读取/复制 C# forwardapi 的账号或秘密。

## 5. 批量读取、CAS 和页面脱敏

```ts
const accounts = await ctx.accounts.list({ includeCredentials: true });
```

需要 read + readCredentials，默认 list 仍不含秘密。一次批量调用避免逐账号消耗宿主调用配额，但仍受整体返回大小限制。旧宿主没有此能力时明确失败，不绕过授权。

`accounts.ts` 卡片隐藏 API Key/密码，也对额外认证信息做掩码回填。密钥/密码留空保留原值；新账号不能把掩码当作真实密钥。

候选模型/额度更新用凭证 CAS：

```ts
await ctx.accounts.compareExchangeCredential(id, version, fullCredential);
```

提交完整新凭据。冲突返回 409，重新读取，不重复执行已发出的上游操作；不将旧账号快照覆盖到并发冷却。管理状态只在明确需要时字段级更新，模型错误动作不重复写。

## 6. 目录和批量选号

`getModels` 只合并启用账号的允许表，返回平台内 ID，宿主发布为 `js-forwardapi/<模型>`。

`selectAccounts` 同步处理整批候选：

1. 解析附带凭据，坏配置不参与。
2. 检查 enabled、端点和模型允许表。
3. 返回 accountId、eligible、weight。

宿主先执行归属、停用、冷却等硬条件。脚本不能扩大候选范围，不做 HTTP、账号写入或任务入队。`models/refresh` 只更新候选，不扩大允许表。

## 7. 原始句柄转发

[plugin.ts](../../plugins/js-forwardapi/src/plugin.ts) 的核心：

```ts
const source = await ctx.http.open({
  method: "POST", route: "direct", url, headers, followRedirects: false,
  originalJson: {
    source: ctx.request!.originalBodyRef!,
    remove: ["endpoint", "overrides", "models"],
    set: { model: ctx.request!.model }
  }
});
```

url/headers 来自当前已验证账号。只有指定顶层字段改变，其他原始字段由宿主保留；不能先 parse/stringify 全部原文而丢失大整数，也不能将工具、图片、文件和推理缩成文本。

Messages 默认 x-api-key、anthropic-version；其他入口默认 Bearer。当前账号的认证头覆盖下游同名自定义头，最后应用额外参数 `ReplaceHeaders`，按头名不区分大小写替换或新增；示例和限制见[插件说明](../../plugins/js-forwardapi/README.md#替换或新增转发请求头)。URL 组合保留部署子路径、消除重复 /v1。

模型获取和刷新共用 `fetchModels`，其 `GET /v1/models` 也在生成账号认证头后应用 `ReplaceHeaders`；额度查询、登录和签到不使用这组覆盖项。

## 8. raw/SSE 所有权

- 上游 SSE 或下游要求 stream 时，`return ctx.reply.raw(source)`。
- 移交后不再 read/close；宿主持有引擎、HTTP 和取消链到最后一个字节。
- 这是原始透传，不用 mappedStream，不往未知字节协议塞通用错误帧。
- 非流式返回 Base64 原字节，usage 只做统计，不重新序列化正文。
- 非 2xx 先读取摘要和原字节、关闭 source，再返回明确决策；错误不能伪装成已经开始的流。
- 已返回流不再生成第二条请求，最后写出失败不算成功。

SDK 边界：缓冲请求/响应 4 MiB，raw 流累计 32 MiB，同步工具输入 1 MiB。插件只为较小 JSON 缓冲响应提取 usage；过大/非 JSON 时不猜用量。这不是无限容量 C# 缓冲的承诺。

## 9. 重试规则

| 情况 | 决策 |
| --- | --- |
| 401 / 明确无效凭据的 403 | Disable + NextAttempt |
| 429 / 5xx | 约 5 分钟冷却 + NextAttempt |
| 408 / 425 | NextAttempt，不凭空惩罚节点 |
| direct 工厂报告传输失败 | 申请下一次 attempt/账号冷却，不伪造代理证据 |
| 配置、句柄、权限、预算错误 | Plugin 错误，无惩罚、无重放 |
| 已返回 raw 流 | 结束/失败，不启动第二次生成 |

宿主执行动作/预算，插件只返回 decision。HTTP 工厂不按业务状态码换号；登录/签到等 POST 不设置传输 retry。

## 10. 精确额度

[quota.ts](../../plugins/js-forwardapi/src/quota.ts)：

- NewAPI `/api/usage/token`，可读 `/api/status` 换算单位。
- Sub2API `/v1/usage`，兼容 quota、subscription、rate_limits、usage.total.cost。
- 404/405 可尝试尾斜杠，失败/未知字段不是余额 0。
- 无限额单独表示，不捏造剩余额度。
- JSON 数字令牌先保留为字符串，再用 ctx.decimal 运算；快照金额保存为字符串。
- 以凭证版本 CAS 保存，冲突不重放网络、不覆盖冷却。

页面可以格式化两位小数，但显示值不能写回为资金事实。

## 11. 签到、Cron、job

[checkin.ts](../../plugins/js-forwardapi/src/checkin.ts) 共用流程：

```text
读取账号 → 路径校验 → 可选登录 → token/Cookie/精确 UID
 → 模板替换 → 签到 → 解释业务状态 → 逐账号日志
```

NewAPI 默认 `/api/user/checkin`、`/api/user/sign_in`；其他类型显式配置。拒绝绝对地址、反斜杠、编码穿越和危险连接头。Cookie 仅在本次客户端流程中显式传递，不共用容器。

HTTP 200 的 HTML/未知 JSON 仍失败；明确已签到为 Already。仅路径不可用才用备用地址，普通失败/超时不重放 POST。

- `checkin/run`：同步，受管理端点约 25 秒预算限制。
- `checkin/start`：202 + job，只传账号 ID，推荐页面使用。
- `jobs/status?id=...`：查询；`jobs/cancel`：请求取消，不冒充已退出。
- 同账号活跃 key 去重，完成后可重新创建，不是持久跨实例队列。
- Cron 每天 10:10，经原生任务锁，处理启用且开启自动签到的账号。

取消继续传播；HTTP/source 句柄不进入下一次 job。

## 12. 页面和安装

[页面](../../plugins/js-forwardapi/ui/index.html) 沿用账号卡片/表单，增加明确授权和后台签到取消/轮询。额度自动刷新最多 2 个并发请求，避免淹没控制面。

浏览器用 window.Router2API，父页负责插件前缀、Cookie、CSRF；没有 ctx。不把凭据写到 localStorage、URL、console。`origins` / `origins/revoke` 管理额外授权，撤销不删除账号。

完整发行包复制到独立宿主运行目录的 `plugins/js-forwardapi`（容器通常 `/app/plugins`），不复制 TS/node_modules/测试/开发配置。JS 仓库不编译或启动宿主源码。

重载后确认 jint/Active/版本/页面，录入测试账号，调用 `js-forwardapi/<允许模型>`。测试四种入口、stream 两种模式、取消，再接真实上游。

## 13. Node 模拟测试

```powershell
npm run check
npm test
npm run build:forwardapi
```

[forwardapi.test.mjs](../../plugins/js-forwardapi/forwardapi.test.mjs) 进程内转译 TS 并模拟账号/CAS、状态、HTTP、source、job、日志，覆盖授权、目录信任、秘密保持、脱敏、选号、raw/SSE、决策、额度、Cookie/UID、备用路径和取消。它不启动子进程；实际 esbuild 安装包由 `npm run test:build` 单独检查。

这是 Node 模拟测试，**不声称执行 Jint、SQLite、真实浏览器或上游账号**。真实框架回归属于宿主；JS 仓库不加入 C# 项目或宿主源码依赖。

改插件先补能复现行为的 mock 用例，再修改模块，不能为了测试而关闭权限。发布前仍需独立测试宿主验收，记录未执行项。

## 14. 扩展自己的插件

从案例复制必要模块，统一修改 id/platform、目录、任务名及文档；不要复制账号秘密或宿主实现。Echo 仅保留作 SDK 脚手架/工具 smoke test，不是主教程。

顺序：最小权限 → 输入校验 → ctx → 错误/取消/所有权 → Node 用例 → 类型检查/打包 → 独立宿主验收。缺少能力先说明契约差异，不编造 ctx.fetch/CLR/跨插件数据库。
