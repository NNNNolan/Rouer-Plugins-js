/**
 * 账号管理与模型目录。沿用 C# Custom 字段格式，但新插件账号归 js-forwardapi 所有。
 * 不共享 C# 插件的账号池，不信任浏览器伪造的可用模型目录，不在选号阶段做 I/O。
 */
import type { AccountSelectionInput, Credential, PluginContext } from "../../../sdk/js/index";
import {
  ApiError, ENDPOINTS, SECRET_PLACEHOLDER, accountId, allowedModels, authHeaders, authorize, baseUrl,
  buildUrl, cancelled, describe, field, input, isObject, log, modelIds, parseObject, patchCredential,
  readAccount, recordFrom, records, requestText, settingsFrom, storedJson, text,
  type AccountRecord, type Settings
} from "./common";

const DEFAULTS: Settings = {
  siteType: "NewAPI", baseUrl: "", apiKey: "", username: "", password: "", weight: 0,
  endpoints: ENDPOINTS, autoCheckIn: false, enabled: true, extraParams: "{}"
};
/** 只有管理员明确提交的秘密才会替换原值；掩码不能在新账号中变成真实认证值。 */
function restoreExtras(value: unknown, previous: unknown): unknown {
  if (value === SECRET_PLACEHOLDER) {
    if (typeof previous !== "string") throw new ApiError(400, "秘密占位符没有对应的原值");
    return previous;
  }
  if (Array.isArray(value)) return value.map((item, index) => restoreExtras(item, Array.isArray(previous) ? previous[index] : undefined));
  if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, restoreExtras(item, field(previous, key))]));
  return value;
}
/** 管理卡片不返回 API Key、密码，额外参数中的认证头/秘密值也使用可回填掩码。 */
function publicExtras(value: unknown, settings: Settings, key = ""): unknown {
  if (typeof value === "string" && value && (
    /auth|api.?key|token|password|cookie|secret/i.test(key) && !/^(quota)?apiKey(Header|Prefix)$/i.test(key) && !/\{\{[a-z_]+\}\}/i.test(value)
    || [settings.apiKey, settings.password].some(secret => secret && value.includes(secret))))
    return SECRET_PLACEHOLDER;
  if (Array.isArray(value)) return value.map(item => publicExtras(item, settings, key));
  if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, publicExtras(item, settings, name)]));
  return value;
}
export function card(record: AccountRecord) {
  const { account, credential, settings } = record;
  const key = settings.apiKey;
  return {
    id: account.id, label: account.label ?? "", siteType: settings.siteType, baseUrl: settings.baseUrl,
    apiKeyMasked: key.length <= 6 ? "••••••" : `••••••${key.slice(-4)}`, hasApiKey: !!key,
    username: settings.username, hasPassword: !!settings.password, weight: settings.weight,
    endpoints: settings.endpoints, autoCheckIn: settings.autoCheckIn, enabled: settings.enabled,
    extraParams: JSON.stringify(publicExtras(parseObject(settings.extraParams), settings)),
    models: allowedModels(record), availableModels: modelIds(storedJson(credential.fields.availableModels)),
    modelsUpdatedAt: credential.fields.modelsUpdatedAt ?? null,
    quota: storedJson(credential.fields.quotaSnapshot), quotaUpdatedAt: credential.fields.quotaUpdatedAt ?? null,
    state: account.status.state
  };
}
/** 合并编辑表单，空 API Key/密码保持原值；其余字段使用 C# 同名配置。 */
function formSettings(ctx: PluginContext, body: Record<string, unknown>, previous = DEFAULTS): Settings {
  const oldExtra = parseObject(previous.extraParams);
  const requested = field(body, "extraParams");
  const params = requested == null ? oldExtra : restoreExtras(parseObject(requested, "额外参数"), oldExtra);
  return settingsFrom(ctx, {
    siteType: field(body, "siteType") ?? previous.siteType,
    baseUrl: field(body, "baseUrl") ?? previous.baseUrl,
    apiKey: text(field(body, "apiKey")).trim() || previous.apiKey,
    username: field(body, "username") ?? previous.username,
    password: text(field(body, "password")) || previous.password,
    weight: field(body, "weight") ?? previous.weight,
    endpoints: field(body, "endpoints") ?? previous.endpoints,
    autoCheckIn: field(body, "autoCheckIn") ?? previous.autoCheckIn,
    enabled: field(body, "enabled") ?? previous.enabled, extraParams: params
  });
}
function connection(settings: Settings): string {
  return JSON.stringify([settings.siteType, settings.baseUrl, settings.apiKey, settings.extraParams]);
}
function discoveryKey(ctx: PluginContext, settings: Settings): string {
  return `discovery:${ctx.crypto.sha256(connection(settings))}`;
}
/** GET /v1/models；没有模型、非法 JSON、业务失败都不伪装为一个成功空目录。 */
export async function fetchModels(ctx: PluginContext, settings: Settings): Promise<string[]> {
  const response = await requestText(ctx, {
    url: buildUrl(ctx, settings.baseUrl, "/v1/models"), headers: authHeaders(settings)
  });
  if (response.statusCode < 200 || response.statusCode >= 300)
    throw new ApiError(response.statusCode >= 400 ? response.statusCode : 502, describe(response.statusCode, response.bodyText, settings));
  const body = storedJson(response.bodyText);
  const list = field(body, "data") ?? field(body, "models");
  const models = modelIds(Array.isArray(list) ? list.map(item => field(item, "id") ?? field(item, "name")) : [])
    .sort((left, right) => left.toLowerCase().localeCompare(right.toLowerCase()));
  if (!models.length) throw new ApiError(502, "上游模型响应没有可用的 data[].id / models[].id");
  if (models.length > 2000) throw new ApiError(502, "模型目录超过宿主的 2000 项上限");
  return models;
}
export async function discoverModels(ctx: PluginContext) {
  const body = input(ctx), id = field(body, "id");
  const existing = id ? await readAccount(ctx, accountId(id)) : undefined;
  const settings = formSettings(ctx, body, existing?.settings);
  await authorize(ctx, settings, field(body, "approveOrigin"));
  const models = await fetchModels(ctx, settings), updatedAt = new Date().toISOString();
  // 本代、5 分钟的发现凭据。只缓存目录/时间，缓存键是指纹，不保存明文密钥。
  await ctx.state.local.set(discoveryKey(ctx, settings), { models, updatedAt }, { ttlSeconds: 300 });
  return ctx.json(200, { models, count: models.length, updatedAt });
}
export async function listAccounts(ctx: PluginContext) {
  const accounts = await ctx.accounts.list({ includeCredentials: true });
  return ctx.json(200, { accounts: accounts.map(account => {
    try {
      if (!account.credential) throw new Error("credential");
      return card(recordFrom(ctx, account, account.credential));
    } catch {
      // 一个外部录入的坏账号不能阻止管理员查看/删除其他账号，秘密仍不进入页面。
      return {
        id: account.id, label: account.label ?? "", siteType: "Custom", baseUrl: "",
        enabled: false, state: account.status.state, models: [], availableModels: [], endpoints: [],
        hasApiKey: false, hasPassword: false, extraParams: "{}", configurationError: "配置无效，请删除后重新添加"
      };
    }
  }) });
}
export async function saveAccount(ctx: PluginContext) {
  const body = input(ctx), id = field(body, "id");
  const existing = id ? await readAccount(ctx, accountId(id)) : undefined;
  const label = text(field(body, "label")).trim();
  if (!label || label.length > 128) throw new ApiError(400, "账号名称须为 1–128 字符");
  const settings = formSettings(ctx, body, existing?.settings);
  await authorize(ctx, settings); // 保存不会静默批准 URL；必须先在发现流程显式授权。
  const changed = !existing || connection(settings) !== connection(existing.settings);
  const models = field(body, "models") == null
    ? changed || !existing ? [] : allowedModels(existing)
    : modelIds(field(body, "models"));
  if (!models.length) throw new ApiError(400, "请先获取模型并至少选择一个允许使用的模型");
  let available = existing ? modelIds(storedJson(existing.credential.fields.availableModels)) : [];
  let updatedAt = existing?.credential.fields.modelsUpdatedAt ?? null;
  const discovery = await ctx.state.local.get(discoveryKey(ctx, settings));
  if (isObject(discovery) && Array.isArray(discovery.models)) {
    available = modelIds(discovery.models);
    updatedAt = text(discovery.updatedAt) || null;
  } else if (changed || !available.length || !updatedAt) {
    throw new ApiError(409, "模型发现已过期或连接参数已改变，请重新获取模型");
  }
  const accepted = new Set(available.map(model => model.toLowerCase()));
  if (models.some(model => !accepted.has(model.toLowerCase())))
    throw new ApiError(400, "只能选择服务端本次模型目录中返回的模型");
  const fields = { ...existing?.credential.fields };
  if (changed) { delete fields.quotaSnapshot; delete fields.quotaUpdatedAt; }
  Object.assign(fields, {
    settings: JSON.stringify(settings), models: JSON.stringify(models), modelsConfigured: "true",
    availableModels: JSON.stringify(available), modelsUpdatedAt: updatedAt
  });
  const credential: Extract<Credential, { kind: "Custom" }> = { kind: "Custom", fields };
  let account;
  if (existing) {
    await patchCredential(ctx, existing, fields);
    account = await ctx.accounts.save({ id: existing.account.id, label });
    // 显式恢复管理状态，只改所需字段，不把旧快照的并发冷却覆盖回去。
    if ((changed || field(body, "enabled") === true) && ["Disabled", "Invalid"].includes(existing.account.status.state))
      account = await ctx.accounts.save({ id: account.id, status: { state: "Active", disabledUntil: null } });
  } else {
    account = await ctx.accounts.save({ label, credential });
  }
  await ctx.models.invalidate();
  await log(ctx, "account.saved", "账号配置已保存", account.id);
  return ctx.json(200, { account: card(recordFrom(ctx, account, credential)) });
}
export async function deleteAccount(ctx: PluginContext) {
  const id = accountId(field(input(ctx), "id"));
  if (!await ctx.accounts.get(id)) throw new ApiError(404, "账号不存在");
  await ctx.accounts.delete(id);
  await ctx.models.invalidate();
  await log(ctx, "account.deleted", "账号已删除", id);
  return ctx.json(200, { deleted: true });
}
export async function refreshModels(ctx: PluginContext) {
  const record = await readAccount(ctx, accountId(field(input(ctx), "id")));
  const models = await fetchModels(ctx, record.settings);
  await patchCredential(ctx, record, {
    ...record.credential.fields, availableModels: JSON.stringify(models), modelsUpdatedAt: new Date().toISOString()
  });
  // 候选目录刷新不自动扩大 models 允许表；仍由管理员选择后保存。
  await log(ctx, "models.refresh.succeeded", `成功拉取 ${models.length} 个候选模型`, record.account.id);
  return ctx.json(200, { models, count: models.length });
}
/** 模型目录来自持久化允许表；与 C# 一样，不把发现到的所有模型直接向下游开放。 */
export async function getModels(ctx: PluginContext) {
  const items = await records(ctx, true);
  return modelIds(items.filter(item => item.settings.enabled && !["Disabled", "Invalid", "Removed"].includes(item.account.status.state))
    .flatMap(allowedModels)).sort().map(id => ({ id, displayName: id, supportsStreaming: true }));
}
/** 同步整批选号：只读输入快照；不查询 HTTP、账号数据库或写状态。 */
export function selectAccounts(ctx: PluginContext, selection: AccountSelectionInput) {
  return selection.candidates.map(account => {
    try {
      if (!account.credential) throw new Error("credential");
      const record = recordFrom(ctx, account, account.credential);
      return { accountId: account.id, eligible: eligible(record, ctx), weight: record.settings.weight };
    } catch (error) {
      if (cancelled(error)) throw error;
      return { accountId: account.id, eligible: false };
    }
  });
}
export function eligible(record: AccountRecord, ctx: PluginContext): boolean {
  return record.settings.enabled && record.settings.endpoints.some(value => value.toLowerCase() === ctx.request?.endpoint.toLowerCase())
    && allowedModels(record).some(value => value.toLowerCase() === ctx.request?.model.toLowerCase());
}
export function validateCredential(ctx: PluginContext, credential: Credential) {
  try {
    if (credential.kind !== "Custom") throw new ApiError(400, "需要 Custom 凭据");
    settingsFrom(ctx, credential.fields.settings);
    return { success: true };
  } catch (error) {
    if (cancelled(error)) throw error;
    return { success: false, error: error instanceof ApiError ? error.message : "账号配置无效" };
  }
}
export async function listOrigins(ctx: PluginContext) {
  return ctx.json(200, { origins: await ctx.http.approvedOrigins() });
}
export async function revokeOrigin(ctx: PluginContext) {
  const value = baseUrl(ctx, text(field(input(ctx), "origin")));
  const origin = ctx.url.parse(value).origin;
  if (value !== origin && value !== origin + "/") throw new ApiError(400, "只能撤销精确 origin，不能带路径");
  await ctx.http.revokeOrigin(origin);
  return ctx.json(200, { revoked: true });
}
