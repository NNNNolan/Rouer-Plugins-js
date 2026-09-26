# Jint JS Plugin API 1

本文是按能力查阅的参考手册。第一次开发按 [完整开发流程](DEVELOPMENT.md) 操作；宿主如何调用这些 API 见 [运行流程](../HOST-LIFECYCLE.md)，AI 实现/验收要求见 [工作单](../AI-DEVELOPMENT.md)。

运行时为 **Jint 4.16.4 / .NET 10**。生产不需要 Node。`hostApi: "1"` 可用，已有 `"1-preview"` 包继续兼容。完整类型见 [`index.d.ts`](index.d.ts)，逐项验收见 [能力对照表](CAPABILITIES.md)。

这里对齐的是宿主插件能力：可以用 JS 编写现有 C# 插件的账号、模型、选号、协议、任务及管理页面逻辑。**当前具体迁移案例为 js-forwardapi；不开放 CLR、任意本地文件或进程 API，不声称其他提供方已迁移。**

## 开发、打包与安装

```powershell
npm --prefix sdk/js ci
node sdk/js/init.mjs ./my-plugin
cd my-plugin
npm install
npm run check
npm run build
```

生成的 `dist/<id>` 才是安装包：复制到宿主运行目录的 `plugins/<id>`，再重载。构建使用 esbuild，将 JS/TS 和纯 JS 依赖打成单个 ESM bundle；不执行插件代码，不安装插件依赖，不允许 `node:*` 或残留的运行时 imports。生产加载器仍会独立验证命名导出、大小、路径和重解析点。

已有包可直接构建：

```powershell
node sdk/js/build.mjs plugins/js-proxy-demo artifacts/plugins/js-proxy-demo
```

示例不自动安装，也不会仅因编译而发送外部请求。示例的 Echo 无网络；手动后台检查和每日 Cron 会访问明确授权的 `example.com`。

## 清单与生命周期

```json
{
  "schemaVersion": 1,
  "id": "sample",
  "name": "Sample",
  "version": "1.0.0",
  "runtime": "jint",
  "hostApi": "1",
  "entry": "server/plugin.mjs",
  "format": "esm-bundle",
  "platform": {
    "name": "sample",
    "credentialKinds": ["OAuth"],
    "modelCacheTtlSeconds": 300
  },
  "hooks": {
    "invoke": "invoke",
    "getModels": "getModels",
    "validateCredential": "validateCredential",
    "selectAccounts": "selectAccounts",
    "refreshCredential": "refreshCredential",
    "start": "start",
    "stop": "stop"
  },
  "permissions": {
    "accounts": ["read", "readCredentials", "write", "refresh", "setCooldown", "disable"],
    "state": ["read", "write"],
    "sharedState": ["read", "write"],
    "models": ["read", "refresh", "invalidate"],
    "tasks": ["run", "writeLog"],
    "jobs": ["start", "read", "cancel"],
    "crypto": ["random", "hash", "hmac", "encoding", "decimal"],
    "http": { "origins": ["https://api.example.com"], "routes": ["direct", "pool", "attempt"] }
  },
  "policy": {
    "maxAttempts": 3,
    "attemptTimeoutSeconds": 60,
    "totalTimeoutSeconds": 180,
    "transportFailure": { "retry": true, "cooldownProxy": true, "accountCooldownSeconds": 0 }
  }
}
```

只声明实际用到的 hook/权限。每次调用一个独立 Engine；模块变量不跨调用保存。状态放到 `ctx.state`，长期工作放到 `ctx.jobs`。未 await 的宿主操作会被取消并判错。`ctx.phase`、`pluginVersion`、`generationId` 由宿主产生，不能通过 JSON 参数修改权限归属。

多平台包使用 `platforms` 数组代替 `platform`，最多 16 个。每个平台可覆写 `hooks`、`policy`、模型 TTL 和 `probeEndpoint`；端点、Cron、job 用 `platform` 指定归属，未指定时属于第一个平台。策略按 `pluginKey + platform` 存储，不互相覆盖；本代状态和 job registry 由包共享。

## 账号与凭证

```js
const accounts = await ctx.accounts.list(); // 默认不含秘密
const internalAccounts = await ctx.accounts.list({ includeCredentials: true }); // 另需 readCredentials，只供后端
const account = await ctx.accounts.get(id); // 默认不包含秘密字段
const saved = await ctx.accounts.save({
  id, label: "my account",
  credential: { kind: "OAuth", accessToken, refreshToken, domain, expiresAt }
});
await ctx.accounts.delete(id);
```

支持 ApiKey、OAuth、Custom、BearerToken、BasicAuth、Cookie。只能操作本插件声明平台内的账号，不能改变已有账号身份/平台。`save` 更新现有账号时仅写实际提供的字段，不把旧快照里的冷却等状态覆盖回数据库。

读取/刷新凭证：

```js
const snapshot = await ctx.accounts.readCredentials(id);
const updated = await ctx.accounts.compareExchangeCredential(id, snapshot.version, credential);
if (updated === null) { /* 凭证已被其他调用修改，重新读取，不能盲目覆盖 */ }

const refreshed = await ctx.accounts.refresh(id);
```

`version` 是字符串。CAS 在 SQLite 中按 `CredentialVersion` 条件更新，只修改凭据和对应有效期/昵称，保留冷却、停用等状态。`accounts.refresh(id)` 需要声明 `hooks.refreshCredential`：

```js
export async function refreshCredential(ctx, account) {
  // 已持有本宿主的账号刷新锁；输入是最新账号及凭证。
  if (account.credential.expiresAt &&
      Date.parse(account.credential.expiresAt) > Date.now() + 120000)
    return account.credential;
  const result = await ctx.http.request({
    url: "https://api.example.com/refresh", route: "direct", method: "POST",
    body: { refreshToken: account.credential.refreshToken }
  });
  return { ...account.credential, accessToken: result.body.accessToken };
}
```

刷新 hook 在**独立回调 Engine**中运行，不重入当前 Engine；结束后仍 CAS 提交。刷新锁是进程内串行化，跨实例靠 CAS 防止覆盖，不能承诺跨实例只向上游刷新一次。

`setCooldown(id, until, reason, statusCode?)`、`clearCooldown(id, expectedReason)`、`disable(id, reason, statusCode?)` 是显式账号动作。`save.status` 的状态/停用字段另需 `disable` 权限，冷却/原因/失败计数另需 `setCooldown` 权限，不能借普通写权限绕过。
模型错误优先返回 `attempt.decision`，不要先写同一动作再让宿主执行第二遍。

## 批量选号

```js
export async function selectAccounts(ctx, { candidates }) {
  const cached = await ctx.state.local.get("account-policy") || {};
  return candidates.map(a => ({
    accountId: a.id,
    eligible: true,
    preferredExpiry: cached[a.id]?.nextCreditExpiry || null,
    weight: parseInt(ctx.crypto.sha256(ctx.request.headers["x-session-id"] + ":" + a.id).slice(0, 8), 16) | 0
  }));
}
```

宿主先执行归属/停用/冷却等硬过滤，然后整批调用一次 hook；不会每个账号建立 Engine。输出不得包含外来/重复 ID。截止时间升序、同期限权重降序；null 无到期优先。可以据此实现 js-forwardapi 的模型/端点允许表和权重；其他业务可另行提供到期偏好。站点、模型、端点等提供方特有筛选仍需写在 hook 中。

选号允许读取本地/共享状态及同步工具，**不允许 HTTP、写账号/状态或启动任务**。缓存预热放到 start、Cron 或 job。默认候选不含凭证秘密；只有显式 `readCredentials` 权限才附加 `credential`。

## 状态

`ctx.state` 是 `ctx.state.local` 的兼容别名；`ctx.state.shared` 使用插件命名空间的 Redis，未配置/不可用时明确失败，绝不静默退回内存。

两种后端都提供：

- `get/set/remove`：JSON 值；
- `getString/setString`：与 C# 字符串状态直接互通；
- `available/expiry`；
- `putIfAbsent`、`increment`、`compareExchange`：原子操作。

```js
await ctx.state.shared.putIfAbsent("once", { started: true }, { ttlSeconds: 300 });
await ctx.state.local.compareExchange("value", undefined, { count: 1 }, { ttlSeconds: 60 });
const exactCounter = await ctx.state.shared.increment("counter", "1", { ttlSeconds: 3600 });
```

CAS 的 `undefined` expected 表示键缺失，`undefined` value 表示删除；JSON null 仍是合法存储值。计数器返回精确 Int64 字符串，用 `getString` 读取大数，避免经过 JS Number。

本地：key 128 字符、64 KiB/value、256 项、TTL 最多一天。共享：key 128 字符、4 MiB/value、TTL 最多 30 天。刷新失败不得用错误时间冒充成功数据更新时间。宿主任务锁、账号冷却和其他插件的键不可访问。

## HTTP、原始请求与二进制

`ctx.http.request/open` 支持 JSON、文本、Base64 字节和 URL 编码表单。`responseType: "base64"` 返回 `bodyBase64`，其余返回 `body/bodyText`。

- `attempt` 使用当前宿主尝试绑定的代理/直连选择；不能在任务中伪造。
- `pool` 独立选代理，没有可用代理默认失败；显式 `allowDirectFallback` 还需要 direct 路由权限。
- `direct` 显式直连，无系统代理或共享 Cookie。
- 可选传输重试仅用于 pool、仅处理传输异常，不按 401/407/429/5xx 重试/换号；POST 等重放必须显式 `allowUnsafeMethods`。
- 多次模型 attempt 不能再叠加 pool retry。返回 SSE 后不重放生成请求。
- 自动重定向默认关闭；`followRedirects` 每跳重新检查 origin，最多 5 跳，跨 origin 只允许跳转后的 GET/HEAD，并只保留 Accept/Accept-Language/User-Agent。

当前跨 origin 检查依据跳转后的方法，而非一概检测正文是否存在；不要对带正文的 GET/HEAD 使用跨 origin 跳转。对于 POST 的 301/302 或非 HEAD 的 303，宿主改为 GET 并去掉正文；跨 origin 的 307/308 不会替非 GET/HEAD 重放。

需要同一代理做一组请求：

```js
const client = await ctx.http.createClient({ route: "pool" });
try {
  await client.request({ url: "https://api.example.com/login", method: "POST", form: { user, password } });
  const result = await client.request({ url: "https://api.example.com/status" });
} finally { await client.close(); }
```

client/source 句柄仅属于本次调用，不能存入状态给下一次 Engine 使用。固定客户端不叠加传输重试。Cookie 由插件明确读取/传递，不维护共享 Cookie 容器。

ForwardAPI 式原始协议请求可避免大整数和未知字段在 JS 中丢失：

```js
const source = await ctx.http.open({
  url, method: "POST", route: "attempt",
  originalJson: {
    source: ctx.request.originalBodyRef,
    remove: ["endpoint", "overrides", "models"],
    set: { model: ctx.request.model }
  }
});
return ctx.reply.raw(source);
```

编辑由宿主在原 JSON 上执行；不开放文件路径、JSON Pointer 或任意宿主对象。也可返回 `{kind:"raw",statusCode,bodyBase64,contentType}` 或 `bodyText` 构造字节响应。

动态转发站点不能靠通配符放行。清单声明 `http.manageOrigins: true` 后，**仅经过宿主管理员认证的管理端点**可调用 `approveOrigin(origin)` / `revokeOrigin(origin)`；授权按插件存入 SQLite，普通模型/任务不能授权新目标。后续发送仍逐次检查授权。

## SSE 与响应生命周期

清单声明 `streamMappers: { chat: { event:"mapEvent", end:"endStream", completion:"finalize" } }`。
`ctx.reply.mappedStream(source, "chat", state)` 返回宿主管理的转换流；mapper 同步返回 `{state,chunks,done?}`，不得启动异步宿主 I/O。可使用有界的同步 crypto/编码工具。

- 同时支持 UTF-8 拆包、多行 data、注释、工具/reasoning/signature/usage、唯一 finish 和 EOF 校验。
- 非流式客户端使用同一 mapper 聚合，可声明 finalizer。
- `readText/readJson/readBase64/drain` 消费并关闭 source；`snapshotError` 缓存有界错误正文，保留 raw 回传。
- Engine、响应、请求、客户端、账号/代理租约随响应持有到完整写出，取消始终传回上游。
- 4 MiB HTTP request/缓冲响应、32 MiB raw/聚合，流空闲与整体截止时间分别处理。

## 后台任务、Cron 与模型

```json
{
  "tasks": [
    { "name": "refresh", "handler": "refreshAll", "cron": "0 */5 * * * *", "timeoutSeconds": 1800 }
  ],
  "jobs": [
    { "name": "refresh-one", "handler": "refreshOne", "timeoutSeconds": 300 }
  ]
}
```

`tasks.run(name)` 等待已注册 Cron 任务，复用宿主任务锁。`jobs.start` 返回 queued/running 快照，不依赖当前 HTTP 请求。Cron 任务也可按同名启动后台 job，该入口仍经过原生 task invoker/任务锁，结果为 `{succeeded:true}`；需要参数、结果和进度的工作声明在 `jobs`。

```js
const job = await ctx.jobs.start("refresh-one", { accountId }, { key: accountId });
const status = await ctx.jobs.get(job.id);
await ctx.jobs.cancel(job.id);
```

job handler 接收 `(ctx, input)`，可 `await ctx.jobs.progress(json)` 并返回 JSON。提供 list/get/wait/cancel，活跃同 key 去重；每版本一个 job 执行槽，128 个未完成任务，完成记录有界保留。输入 64 KiB、进度 64 KiB、结果 256 KiB，声明超时最多一小时；不是跨重启的持久队列。重载/停用时拒绝入队、取消并等待真实退出，不能提前释放 Engine。

`models.list/refresh/invalidate(platform?)` 操作本插件平台，`metadata()` 读公共模型能力。模型 TTL/禁用及迟到查询不覆盖新版本的语义与 C# 相同。
`tasks.writeLog`、`log.write` 支持结构化字段/明细；对已读取凭据做错误和日志脱敏，不向脚本投影 CLR 堆栈。

## 同步工具与资源限制

`crypto.randomUUID/hash/sha256/hmacSha256`、`encoding.toBase64/fromBase64/hexToBase64`、`decimal.add/subtract/multiply/divide/compare` 和 `url.parse/resolve` 都不依赖 Node。十进制运算使用字符串，精度对齐 .NET decimal。

前台每调用最多 512 次宿主异步操作，任务/job 为 8192；同时最多 8 个未完成操作。同步工具最多 4096 次/调用。所有引擎仍有限时、语句、递归、分配限制。
普通 JS/TS 依赖可开发期打包，但依赖 Node/浏览器全局的库不能因此在 Jint 中运行。

只安装管理员审阅的可信插件。进程内 Jint、C# facade 和 URL allowlist 不是 OS 沙箱，也不能替代 DNS/远端代理侧 SSRF 隔离。
