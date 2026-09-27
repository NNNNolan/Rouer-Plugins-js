/**
 * 自带提供方代码的离线业务测试：TypeScript 进程内转译 + 模拟 ctx，不启动子进程或连接外网。
 * 本仓库只运行 Node 模拟测试，不包含 C# 项目或宿主源码依赖。
 * Jint/原生 HTTP/SQLite 的框架回归属于宿主仓库，不能把这里的模拟测试冒充真实运行时验收。
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "../../sdk/js/node_modules/typescript/lib/typescript.js";
import { createHash } from "node:crypto";

let plugin, temporary;
const project = path.dirname(fileURLToPath(import.meta.url));
before(async () => {
  temporary = await fs.mkdtemp(path.join(os.tmpdir(), "router2api-forwardapi-"));
  // 单元测试不依赖 esbuild 服务进程；严格类型检查/发行包检查分别由 check 与 test:build 负责。
  for (const entry of await fs.readdir(path.join(project, "src"))) {
    if (!entry.endsWith(".ts")) continue;
    const source = await fs.readFile(path.join(project, "src", entry), "utf8");
    const compiled = ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
      transformers: { after: [context => root => ts.visitEachChild(root, node => {
        const module = (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) ? node.moduleSpecifier : undefined;
        if (module && ts.isStringLiteral(module) && module.text.startsWith("./")) {
          const specifier = ts.factory.createStringLiteral(module.text + ".mjs");
          return ts.isImportDeclaration(node)
            ? ts.factory.updateImportDeclaration(node, node.modifiers, node.importClause, specifier, node.attributes)
            : ts.factory.updateExportDeclaration(node, node.modifiers, node.isTypeOnly, node.exportClause, specifier, node.attributes);
        }
        return node;
      }, context)] }
    }).outputText;
    await fs.writeFile(path.join(temporary, entry.replace(/\.ts$/, ".mjs")), compiled);
  }
  plugin = await import(pathToFileURL(path.join(temporary, "plugin.mjs")).href);
});
after(async () => {
  if (!temporary) return;
  const target = path.resolve(temporary), boundary = path.resolve(os.tmpdir()) + path.sep;
  if (!target.startsWith(boundary) || !path.basename(target).startsWith("router2api-forwardapi-"))
    throw new Error("Unsafe test cleanup path.");
  await fs.rm(target, { recursive: true, force: true });
});

const clone = value => structuredClone(value);
/** 用 Node BigInt 构造独立的十进制参考实现，测试不能用 Number 掩盖精度损失。 */
function decimalReference(operation, left, right) {
  function parse(value) {
    const match = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(value);
    if (!match) throw new Error("invalid decimal");
    return { value: BigInt((match[1] === "-" ? "-" : "") + match[2] + (match[3] ?? "")), scale: (match[3] ?? "").length };
  }
  const a = parse(left), b = parse(right), scale = Math.max(a.scale, b.scale);
  const x = a.value * 10n ** BigInt(scale - a.scale), y = b.value * 10n ** BigInt(scale - b.scale);
  if (operation === "compare") return x < y ? -1 : x > y ? 1 : 0;
  let value, digits;
  if (operation === "add" || operation === "subtract") { value = operation === "add" ? x + y : x - y; digits = scale; }
  else if (operation === "multiply") { value = a.value * b.value; digits = a.scale + b.scale; }
  else { if (!y) throw new Error("division by zero"); value = x * 10n ** 28n / y; digits = 28; }
  const negative = value < 0n ? "-" : "";
  let raw = (value < 0n ? -value : value).toString().padStart(digits + 1, "0");
  if (digits) raw = raw.slice(0, -digits) + "." + raw.slice(-digits);
  return negative + (digits ? raw.replace(/\.?0+$/, "") : raw);
}
const settings = (overrides = {}) => ({
  siteType: "Custom", baseUrl: "https://upstream.example/v1", apiKey: "secret-upstream-key",
  username: "", password: "", weight: 100, enabled: true, autoCheckIn: false,
  endpoints: ["/v1/chat/completions", "/v1/completions", "/v1/responses", "/v1/messages"],
  extraParams: "{}", ...overrides
});
function fixture({ authorized = true } = {}) {
  const database = new Map(), state = new Map(), sources = new Map(), origins = new Set(authorized ? ["https://upstream.example"] : []);
  const calls = [], logs = [], jobs = new Map(), progress = [];
  let handler = async () => ({ statusCode: 200, bodyText: '{"data":[{"id":"model-a"},{"id":"model-b"}]}' });
  let closedClients = 0;
  const metadata = (value, include = false) => ({
    id: value.id, label: value.label, platform: "js-forwardapi", status: clone(value.status),
    credentialKind: "Custom", credentialVersion: String(value.version), credential: include ? clone(value.credential) : null
  });
  const seed = (id = "account-1", options = {}, models = ["model-a"]) => {
    const value = {
      id, version: 1, label: id, status: { state: "Active", cooldownUntil: null },
      credential: { kind: "Custom", fields: {
        settings: JSON.stringify(settings(options)), modelsConfigured: "true",
        models: JSON.stringify(models), availableModels: JSON.stringify(["model-a", "model-b"]), modelsUpdatedAt: new Date().toISOString()
      } }
    };
    database.set(id, value);
    return value;
  };
  const context = (body, overrides = {}) => {
    const ctx = {
      pluginKey: "js-forwardapi", platform: "js-forwardapi", phase: "Control", body, query: {},
      json: (statusCode, body) => ({ statusCode, body }),
      request: { model: "model-a", endpoint: "/v1/chat/completions", stream: false, originalBodyRef: "opaque-request", headers: {} },
      account: database.has("account-1") ? metadata(database.get("account-1")) : null,
      crypto: { sha256: value => createHash("sha256").update(value).digest("hex") },
      url: {
        resolve: (base, relative) => new URL(relative, base).href,
        parse: value => { const url = new URL(value); return { href: url.href, origin: url.origin, query: url.search, fragment: url.hash }; }
      },
      encoding: { fromBase64: value => Buffer.from(value, "base64").toString("utf8") },
      decimal: Object.fromEntries(["add", "subtract", "multiply", "divide", "compare"]
        .map(name => [name, (a, b) => decimalReference(name, a, b)])),
      state: { local: { get: async key => clone(state.get(key) ?? null), set: async (key, value) => { state.set(key, clone(value)); } } },
      models: { invalidate: async () => {} },
      log: { write: async entry => { logs.push(clone(entry)); } },
      tasks: { writeLog: async entry => { logs.push(clone(entry)); } },
      jobs: {
        progress: async value => { progress.push(value); },
        start: async (name, input, options) => {
          const old = [...jobs.values()].find(job => job.key === options.key && job.state === "Queued");
          if (old) return old;
          const job = { id: `job-${jobs.size + 1}`, name, input, key: options.key, state: "Queued" };
          jobs.set(job.id, job);
          return job;
        },
        get: async id => jobs.get(id) ?? null,
        cancel: async id => { const job = jobs.get(id); if (!job) return false; job.state = "Cancelled"; return true; }
      },
      ...overrides
    };
    ctx.accounts = {
      get: async id => database.has(id) ? metadata(database.get(id)) : null,
      list: async options => [...database.values()].map(value => metadata(value, options?.includeCredentials)),
      readCredentials: async id => ({ accountId: id, version: String(database.get(id).version), credential: clone(database.get(id).credential) }),
      currentCredential: async () => clone(database.get(ctx.account.id).credential),
      compareExchangeCredential: async (id, version, credential) => {
        const value = database.get(id);
        if (!value || String(value.version) !== version) return null;
        value.credential = clone(credential); value.version++;
        return metadata(value);
      },
      save: async input => {
        let value = input.id ? database.get(input.id) : null;
        if (!value) {
          value = { id: input.id ?? `new-${database.size}`, version: 1, label: "", status: { state: "Active" }, credential: clone(input.credential) };
          database.set(value.id, value);
        }
        if (input.label !== undefined) value.label = input.label;
        if (input.status) Object.assign(value.status, clone(input.status));
        return metadata(value);
      },
      delete: async id => { database.delete(id); }
    };
    const send = async spec => { calls.push(clone(spec)); const result = await handler(spec); return { headers: {}, ...result }; };
    ctx.http = {
      approvedOrigins: async () => [...origins],
      approveOrigin: async origin => { assert.equal(ctx.phase, "Control"); origins.add(origin); },
      revokeOrigin: async origin => { origins.delete(origin); },
      request: send,
      open: async spec => {
        const result = await send(spec), handle = `source-${sources.size}`;
        sources.set(handle, Buffer.from(result.bodyBase64 ? Buffer.from(result.bodyBase64, "base64") : result.bodyText ?? ""));
        return { handle, statusCode: result.statusCode, headers: result.headers, contentType: result.contentType ?? "application/json" };
      },
      snapshotError: async handle => ({ text: sources.get(handle).toString("utf8").slice(0, 4000), truncated: false }),
      readBase64: async handle => { const value = sources.get(handle).toString("base64"); sources.delete(handle); return value; },
      createClient: async options => {
        assert.equal(options.route, "direct");
        return { handle: "client", request: send, close: async () => { closedClients++; } };
      }
    };
    ctx.reply = {
      raw: source => ({ response: { kind: "raw", source: source.handle }, attempt: { decision: { failureKind: "None" }, statusCode: source.statusCode } }),
      error: (statusCode, message, decision) => ({ response: { kind: "error", statusCode, message }, attempt: { decision } })
    };
    return ctx;
  };
  return { database, state, origins, calls, logs, jobs, progress, seed, context, sources,
    setHandler: value => { handler = value; }, get closedClients() { return closedClients; } };
}

test("清单和页面具备完整管理入口、显式 origin 授权及后台签到", async () => {
  const manifest = JSON.parse(await fs.readFile(path.join(project, "plugin.json"), "utf8"));
  assert.equal(manifest.id, "js-forwardapi");
  for (const hook of Object.values(manifest.hooks)) assert.equal(typeof plugin[hook], "function");
  for (const item of [...manifest.endpoints, ...manifest.tasks, ...manifest.jobs]) assert.equal(typeof plugin[item.handler], "function");
  assert.deepEqual(manifest.permissions.http.origins, []);
  const html = await fs.readFile(path.join(project, manifest.page.entry), "utf8");
  assert.match(html, /approveOrigin/);
  assert.match(html, /checkin\/start/);
  assert.match(html, /jobs\/cancel/);
});
test("未授权不联网；模型发现/保存用服务端匹配的目录而非浏览器伪造目录", async () => {
  const f = fixture({ authorized: false }), body = { label: "demo", ...settings(), models: ["model-a"] };
  assert.equal((await plugin.discoverModels(f.context(body))).statusCode, 403);
  assert.equal(f.calls.length, 0);
  assert.equal((await plugin.saveAccount(f.context({ ...body, availableModels: ["fake"] }))).statusCode, 403);
  assert.equal((await plugin.discoverModels(f.context({ ...body, approveOrigin: true }))).statusCode, 200);
  assert.equal((await plugin.saveAccount(f.context({ ...body, models: ["fake"], availableModels: ["fake"] }))).statusCode, 400);
  const saved = await plugin.saveAccount(f.context(body));
  assert.equal(saved.statusCode, 200);
  assert.deepEqual(saved.body.account.models, ["model-a"]);
  assert.ok(!JSON.stringify(saved).includes(body.apiKey));
});
test("修改密钥后必须重新发现；空密钥/密码保留原值，卡片掩码额外认证信息", async () => {
  const f = fixture();
  f.seed("account-1", { password: "private-password", extraParams: '{"apiKeyHeader":"Authorization","loginHeaders":{"Authorization":"Bearer extra-secret"},"ReplaceHeaders":{"Authorization":"Bearer replacement-secret"}}' });
  const listed = await plugin.listAccounts(f.context({}));
  assert.ok(!JSON.stringify(listed).includes("private-password"));
  assert.ok(!JSON.stringify(listed).includes("extra-secret"));
  assert.ok(!JSON.stringify(listed).includes("replacement-secret"));
  assert.match(listed.body.accounts[0].extraParams, /Authorization/);
  const edited = await plugin.saveAccount(f.context({ id: "account-1", label: "renamed", apiKey: "", password: "", extraParams: listed.body.accounts[0].extraParams }));
  assert.equal(edited.statusCode, 200);
  const savedSettings = JSON.parse(f.database.get("account-1").credential.fields.settings);
  assert.equal(savedSettings.password, "private-password");
  assert.equal(JSON.parse(savedSettings.extraParams).ReplaceHeaders.Authorization, "Bearer replacement-secret");
  assert.equal((await plugin.saveAccount(f.context({ id: "account-1", label: "renamed", apiKey: "replacement-key", models: ["model-a"] }))).statusCode, 409);
});
test("批量选号仅使用允许表/端点/权重，目录刷新不自动扩大允许模型", async () => {
  const f = fixture(); f.seed(); f.seed("disabled", { enabled: false });
  const ctx = f.context({});
  const candidates = await ctx.accounts.list({ includeCredentials: true });
  const selected = plugin.selectAccounts(ctx, { candidates });
  assert.equal(selected[0].eligible, true);
  assert.equal(selected[0].weight, 100);
  assert.equal(selected[1].eligible, false);
  assert.equal(f.calls.length, 0);
  assert.equal((await plugin.refreshModels(f.context({ id: "account-1" }))).statusCode, 200);
  assert.deepEqual(JSON.parse(f.database.get("account-1").credential.fields.models), ["model-a"]);
  assert.deepEqual((await plugin.getModels(ctx)).map(model => model.id), ["model-a"]);
});
test("原始非流式字节不被 stringify，请求使用原生 JSON 编辑并正确生成 Messages 认证头", async () => {
  const f = fixture(); f.seed();
  const raw = '{"id":9007199254740993,"usage":{"input_tokens":2,"output_tokens":3}}';
  f.setHandler(async () => ({ statusCode: 200, bodyText: raw }));
  const ctx = f.context(null, { phase: "Terminal" });
  ctx.request.endpoint = "/v1/messages";
  const result = await plugin.invoke(ctx);
  assert.equal(Buffer.from(result.response.bodyBase64, "base64").toString(), raw);
  assert.deepEqual(result.response.usage, { promptTokens: 2, completionTokens: 3, totalTokens: 5 });
  assert.equal(f.calls[0].body, undefined);
  assert.deepEqual(f.calls[0].originalJson, { source: "opaque-request", remove: ["endpoint", "overrides", "models"], set: { model: "model-a" } });
  assert.equal(f.calls[0].headers["x-api-key"], "secret-upstream-key");
  assert.equal(f.calls[0].headers["anthropic-version"], "2023-06-01");
  assert.equal(f.calls[0].route, "direct");
  assert.equal(f.calls[0].followRedirects, false);
});
test("ReplaceHeaders 在四种端点的流式/非流式转发中最后覆盖同名头并新增缺失头", async () => {
  const userAgent = "claude-cli/2.1.161 (external, cli)";
  for (const endpoint of settings().endpoints) {
    for (const stream of [false, true]) {
      const f = fixture();
      f.seed("account-1", { extraParams: JSON.stringify({
        apiKeyHeader: "X-Upstream-Key",
        ReplaceHeaders: {
          "User-Agent": "first-value", "user-agent": userAgent, "X-Added": "configured",
          "X-Upstream-Key": "replacement-key", "Content-Type": "application/json; profile=forwardapi",
          "anthropic-version": "2023-06-01"
        }
      }) });
      const ctx = f.context(null, { phase: "Terminal" });
      Object.assign(ctx.request, { endpoint, stream, headers: {
        "USER-AGENT": "downstream-client", "x-upstream-key": "downstream-key", "X-Trace": "trace-123",
        "anthropic-version": "old-version", "Content-Type": "application/downstream"
      } });
      const originalHeaders = clone(ctx.request.headers);
      const result = await plugin.invoke(ctx);
      assert.equal(result.response.kind, "raw");
      assert.equal(f.calls.length, 1);
      assert.deepEqual(f.calls[0].headers, {
        "user-agent": userAgent, "x-upstream-key": "replacement-key", "x-trace": "trace-123",
        "anthropic-version": "2023-06-01", "x-added": "configured",
        "content-type": "application/json; profile=forwardapi"
      });
      assert.deepEqual(ctx.request.headers, originalHeaders);
      assert.equal(f.sources.size, stream ? 1 : 0);
    }
  }
});
test("ReplaceHeaders 可显式覆盖账号默认认证头", async () => {
  for (const [endpoint, header] of [["/v1/chat/completions", "Authorization"], ["/v1/messages", "X-Api-Key"]]) {
    const f = fixture();
    f.seed("account-1", { extraParams: JSON.stringify({ ReplaceHeaders: { [header]: "configured-key" } }) });
    const ctx = f.context(null, { phase: "Terminal" });
    ctx.request.endpoint = endpoint;
    assert.equal((await plugin.invoke(ctx)).response.kind, "raw");
    assert.equal(f.calls[0].headers[header.toLowerCase()], "configured-key");
  }
});
test("ReplaceHeaders 在转发和模型发现中只使用当前账号配置，缺省/空对象保持原行为", async () => {
  const f = fixture();
  for (const [id, extraParams, expected] of [
    ["overridden", '{"ReplaceHeaders":{"User-Agent":"configured-client"}}', "configured-client"],
    ["missing", "{}", "downstream-client"],
    ["empty", '{"ReplaceHeaders":{}}', "downstream-client"]
  ]) {
    f.seed(id, { extraParams });
    const ctx = f.context(null, { phase: "Terminal", account: { id } });
    ctx.request.headers["User-Agent"] = "downstream-client";
    assert.equal((await plugin.invoke(ctx)).response.kind, "raw");
    assert.equal(f.calls.at(-1).headers["user-agent"], expected);
    assert.equal(f.calls.at(-1).headers.authorization, "Bearer secret-upstream-key");
    const discovered = await plugin.discoverModels(f.context({ id }));
    assert.equal(discovered.statusCode, 200);
    assert.equal(f.calls.at(-1).headers["user-agent"], id === "overridden" ? "configured-client" : undefined);
  }
});
test("首次获取、已有账号获取和刷新模型均应用 ReplaceHeaders，并覆盖认证头而不是追加", async () => {
  for (const keyHeader of ["Authorization", "X-Upstream-Key"]) {
    const f = fixture(), userAgent = "claude-cli/2.1.161 (external, cli)";
    const extraParams = JSON.stringify({
      apiKeyHeader: keyHeader,
      ReplaceHeaders: {
        "User-Agent": "first-value", "user-agent": userAgent,
        [keyHeader.toLowerCase()]: "replacement-key", "X-Added": "configured"
      }
    });
    f.seed("account-1", { extraParams });
    const results = [
      await plugin.discoverModels(f.context({ ...settings(), extraParams })),
      await plugin.discoverModels(f.context({ id: "account-1" })),
      await plugin.refreshModels(f.context({ id: "account-1" }))
    ];
    assert.ok(results.every(result => result.statusCode === 200));
    assert.equal(f.calls.length, 3);
    for (const call of f.calls) {
      assert.equal(call.method ?? "GET", "GET");
      assert.equal(call.url, "https://upstream.example/v1/models");
      assert.deepEqual(call.headers, {
        [keyHeader.toLowerCase()]: "replacement-key", "user-agent": userAgent, "x-added": "configured"
      });
    }
    assert.deepEqual(JSON.parse(f.database.get("account-1").credential.fields.models), ["model-a"]);
  }
});
test("ReplaceHeaders 拒绝非对象、非字符串、危险头和控制字符，校验失败不发送上游请求", async () => {
  for (const replacements of [
    null, [], "{}", { "X-Test": 1 }, { "X-Test": null }, { "Bad Header": "value" },
    { "User-Agent": "client\r\nX-Injected: value" }, { "User-Agent": "client\u0085value" },
    ...["Host", "Connection", "Content-Length", "Transfer-Encoding", "Upgrade", "Proxy-Authorization", "Cookie", "Set-Cookie"]
      .map(name => ({ [name]: "value" }))
  ]) {
    const f = fixture(), extraParams = JSON.stringify({ ReplaceHeaders: replacements });
    f.seed("account-1", { extraParams });
    assert.equal((await plugin.invoke(f.context(null, { phase: "Terminal" }))).response.statusCode, 400, extraParams);
    assert.equal((await plugin.discoverModels(f.context({ ...settings(), extraParams }))).statusCode, 400, extraParams);
    assert.equal((await plugin.refreshModels(f.context({ id: "account-1" }))).statusCode, 400, extraParams);
    assert.equal((await plugin.saveAccount(f.context({ label: "invalid", ...settings(), extraParams, models: ["model-a"] }))).statusCode, 400, extraParams);
    assert.equal(f.calls.length, 0);
  }
});
test("SSE 只移交 source，不在插件中读取或关闭，不重发生成请求", async () => {
  const f = fixture(); f.seed();
  f.setHandler(async () => ({ statusCode: 200, contentType: "text/event-stream", bodyText: "data: test\n\n" }));
  const result = await plugin.invoke(f.context(null, { phase: "Terminal" }));
  assert.equal(result.response.kind, "raw");
  assert.equal(result.response.source, "source-0");
  assert.equal(f.sources.size, 1);
  assert.equal(f.calls.length, 1);
});
test("401/429/5xx 明确申请动作，错误正文仍按原始字节返回，插件不先改账号", async () => {
  for (const [status, action] of [[401, "Disable"], [429, "Cooldown"], [503, "Cooldown"], [400, "None"]]) {
    const f = fixture(); f.seed();
    const raw = '{"error":{"message":"secret-upstream-key refused"}}';
    f.setHandler(async () => ({ statusCode: status, bodyText: raw }));
    const result = await plugin.invoke(f.context(null, { phase: "Terminal" }));
    assert.equal(result.attempt.decision.accountAction, action);
    assert.equal(result.attempt.decision.proxyAction, "None");
    assert.equal(f.database.get("account-1").status.state, "Active");
    assert.equal(Buffer.from(result.response.bodyBase64, "base64").toString(), raw);
    assert.ok(!JSON.stringify(f.logs).includes("secret-upstream-key"));
    assert.equal(f.sources.size, 0);
  }
});
test("额度适配兼容 NewAPI 单位和 CAS 冲突", async () => {
  const f = fixture(); f.seed("account-1", { siteType: "NewAPI" });
  f.setHandler(async spec => ({ statusCode: 200, bodyText: spec.url.endsWith("/api/status")
    ? '{"data":{"display_in_currency":true,"quota_per_unit":100,"quota_display_type":"USD"}}'
    : '{"data":{"total":1000,"used":200}}' }));
  const result = await plugin.refreshQuota(f.context({ id: "account-1" }));
  assert.equal(result.statusCode, 200);
  assert.deepEqual([result.body.quota.total, result.body.quota.remaining, result.body.quota.unit], ["10", "8", "$"]);
  f.setHandler(async () => {
    f.database.get("account-1").version++;
    return { statusCode: 200, bodyText: '{"data":{"total":900,"used":100}}' };
  });
  assert.equal((await plugin.refreshQuota(f.context({ id: "account-1" }))).statusCode, 409);
});
test("Sub2API 精确大金额、订阅周期、最紧窗口和无限额均不经过 Number", async () => {
  for (const [raw, expected] of [
    ['{"data":{"total_granted":9007199254740993.1,"total_used":0.1}}', ["9007199254740993.1", "9007199254740993", false]],
    ['{"data":{"subscription":{"monthly_limit_usd":100,"monthly_usage_usd":20}}}', ["100", "80", false]],
    ['{"data":{"rate_limits":[{"limit":100,"used":10},{"limit":1000,"used":900}]}}', ["1000", "100", false]],
    ['{"data":{"remaining":-1}}', [null, null, true]]
  ]) {
    const f = fixture(); f.seed("account-1", { siteType: "Sub2API" });
    f.setHandler(async () => ({ statusCode: 200, bodyText: raw }));
    const result = await plugin.refreshQuota(f.context({ id: "account-1" }));
    assert.equal(result.statusCode, 200);
    assert.deepEqual([result.body.quota.total, result.body.quota.remaining, result.body.quota.unlimited], expected);
  }
});
test("NewAPI 登录 Cookie/UID 保真，模板替换，404 备用路径且无传输重试", async () => {
  const f = fixture(); f.seed("account-1", {
    siteType: "NewAPI", username: "admin", password: "password-secret",
    extraParams: '{"checkInBody":{"user_id":"{{user_id}}","nested":[{"name":"{{username}}"}]}}'
  });
  f.setHandler(async spec => spec.url.endsWith("/api/user/login")
    ? { statusCode: 200, headers: { "set-cookie": ["session=cookie-secret; HttpOnly"] }, bodyText: '{"success":true,"data":{"id":9007199254740993}}' }
    : spec.url.endsWith("/api/user/checkin")
      ? { statusCode: 404, bodyText: '{"message":"Invalid URL"}' }
      : { statusCode: 200, bodyText: '{"success":true,"message":"签到成功","data":{"quota_awarded":5}}' });
  const result = await plugin.runCheckIn(f.context({ id: "account-1" }));
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.status, "Success");
  assert.equal(f.calls.length, 3);
  assert.equal(f.calls[1].headers.cookie, "session=cookie-secret");
  assert.equal(f.calls[1].headers["new-api-user"], "9007199254740993");
  assert.equal(f.calls[1].body.user_id, "9007199254740993");
  assert.equal(f.closedClients, 1);
  assert.ok(f.calls.every(call => !call.retry));
  assert.ok(!JSON.stringify(f.logs).includes("cookie-secret"));
});
test("未知/纯 HTML 签到响应不算成功，Custom 不猜接口，取消保持取消", async () => {
  const f = fixture(); f.seed();
  assert.equal((await plugin.runCheckIn(f.context({ id: "account-1" }))).body.status, "Skipped");
  assert.equal(f.calls.length, 0);
  f.seed("account-1", { extraParams: '{"checkInPath":"/api/checkin"}' });
  f.setHandler(async () => ({ statusCode: 200, bodyText: "<html>ok</html>" }));
  assert.equal((await plugin.runCheckIn(f.context({ id: "account-1" }))).body.status, "Failed");
  f.setHandler(async () => { throw Object.assign(new Error("cancelled"), { code: "host.cancelled" }); });
  await assert.rejects(plugin.runCheckIn(f.context({ id: "account-1" })), /cancelled/);
});
test("后台任务使用账号 ID、活跃 key 去重并允许查询/取消", async () => {
  const f = fixture(); f.seed();
  const first = await plugin.startCheckIn(f.context({ id: "account-1" }));
  const second = await plugin.startCheckIn(f.context({ id: "account-1" }));
  assert.equal(first.statusCode, 202);
  assert.equal(first.body.id, second.body.id);
  assert.deepEqual(first.body.input, { id: "account-1" });
  assert.equal((await plugin.jobStatus(f.context(null, { query: { id: first.body.id } }))).body.state, "Queued");
  assert.equal((await plugin.cancelJob(f.context({ id: first.body.id }))).body.accepted, true);
  assert.equal(f.jobs.get(first.body.id).state, "Cancelled");
});
test("拒绝跨 origin/编码穿越路径和危险头；删除不需要解析已损坏的凭据", async () => {
  for (const extraParams of ['{"loginPath":"//attacker.example/x"}', '{"checkInPath":"/%252e%252e/secret"}', '{"apiKeyHeader":"Host"}']) {
    const f = fixture();
    assert.equal((await plugin.discoverModels(f.context({ ...settings(), extraParams }))).statusCode, 400);
    assert.equal(f.calls.length, 0);
  }
  const f = fixture(); const record = f.seed(); record.credential.fields.settings = "broken";
  assert.equal((await plugin.listAccounts(f.context({}))).body.accounts[0].enabled, false);
  assert.equal((await plugin.deleteAccount(f.context({ id: record.id }))).body.deleted, true);
});
