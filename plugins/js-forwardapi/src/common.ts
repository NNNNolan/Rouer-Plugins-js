/**
 * ForwardAPI 的配置、JSON 和 HTTP 小工具。
 * 只使用 ECMAScript 与显式 ctx 能力，不引用 Node/CLR、不在模块顶层执行 I/O。
 */
import type { AccountMetadata, Credential, HttpClientHandle, HttpRequest, Json, PluginContext } from "../../../sdk/js/index";

/** 和 C# ForwardAPI 一致的四种原始协议入口。 */
export const ENDPOINTS = ["/v1/chat/completions", "/v1/completions", "/v1/responses", "/v1/messages"];
/** 管理页面中的秘密占位符；保存时只能替换为同路径原值，不能作为真实密钥提交。 */
export const SECRET_PLACEHOLDER = "[已保存，保持不变]";
export type ObjectValue = Record<string, unknown>;
export interface Settings {
  siteType: "NewAPI" | "Sub2API" | "Custom";
  baseUrl: string;
  apiKey: string;
  username: string;
  password: string;
  weight: number;
  endpoints: string[];
  autoCheckIn: boolean;
  enabled: boolean;
  extraParams: string;
}
/** 一次读取的账号/凭证修订快照；凭证只在后端使用。 */
export interface AccountRecord {
  account: AccountMetadata;
  credential: Extract<Credential, { kind: "Custom" }>;
  version: string;
  settings: Settings;
}

/** 可安全返回给管理员的业务错误；不要把原生异常或完整请求头塞进 message。 */
export class ApiError extends Error {
  constructor(public readonly status: number, message: string) { super(message); }
}
export const isObject = (value: unknown): value is ObjectValue =>
  value !== null && typeof value === "object" && !Array.isArray(value);
/** 兼容 C# Web JSON 的大小写，且只读取自有字段，避免原型链参与配置解释。 */
export function field(object: unknown, name: string): unknown {
  if (!isObject(object)) return undefined;
  const key = Object.keys(object).find(key => key.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : object[key];
}
export const text = (value: unknown, fallback = ""): string => typeof value === "string" ? value : fallback;
export function input(ctx: PluginContext): ObjectValue {
  if (!isObject(ctx.body)) throw new ApiError(400, "请求内容必须是 JSON 对象");
  return ctx.body;
}
export function accountId(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 64 || /[\u0000-\u001f\u007f]/.test(value))
    throw new ApiError(400, "账号 ID 无效");
  return value;
}
export const cancelled = (error: unknown): boolean =>
  isObject(error) && error.code === "host.cancelled";
/** 模型列表不区分大小写去重，但保留原始 ID 的大小写。 */
export function modelIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.filter((item): item is string => typeof item === "string" && !!item.trim())
    .map(item => item.trim()).filter(item => {
      if (item.length > 256) throw new ApiError(400, "模型 ID 超过 256 字符");
      const key = item.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}
export function parseObject(value: unknown, label = "JSON"): ObjectValue {
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    if (isObject(parsed)) return parsed;
  } catch { /* 统一返回不含输入正文的校验错误。 */ }
  throw new ApiError(400, `${label}必须是 JSON 对象`);
}
export function storedJson(value: string | null | undefined): unknown {
  try { return value ? JSON.parse(value) : null; } catch { return null; }
}
/** 严格限制 Base URL；真正发送时宿主仍会重新检查 origin，不能靠此函数扩大权限。 */
export function baseUrl(ctx: PluginContext, value: string): string {
  const candidate = value.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(candidate) || /[\\\u0000-\u0020\u007f]/.test(candidate)
      || /^https?:\/\/[^/?#]*@/i.test(candidate))
    throw new ApiError(400, "Base URL 必须是无用户信息的 HTTP(S) 地址");
  try {
    const url = ctx.url.parse(candidate);
    if (url.query || url.fragment) throw new Error("query");
    return url.href.replace(/\/+$/, "");
  } catch { throw new ApiError(400, "Base URL 不得带查询参数或片段"); }
}
/** 只允许站点内路径，拒绝绝对地址、反斜杠和编码后的路径穿越。 */
export function sitePath(value: string): string {
  let decoded = value.trim();
  try {
    for (let index = 0; index < 2; index++) decoded = decodeURIComponent(decoded);
  } catch { throw new ApiError(400, "站点路径编码无效"); }
  if (!decoded || decoded.startsWith("//") || decoded.includes("\\") || decoded.includes("..")
      || decoded.includes("#") || /^[a-z][a-z0-9+.-]*:/i.test(decoded) || /[\u0000-\u0020\u007f]/.test(decoded))
    throw new ApiError(400, "登录/签到路径必须是安全的站点内路径");
  return value.trim();
}
/** 保留部署子路径，消除重复 /v1；/api/* 管理路径从末尾 /v1 的父目录起算。 */
export function buildUrl(ctx: PluginContext, base: string, path: string): string {
  let root = base.replace(/\/+$/, "") + "/";
  let route = sitePath(path).replace(/^\/+/, "");
  if (/\/v1\/$/i.test(root)) {
    if (/^v1\//i.test(route)) route = route.slice(3);
    else if (/^api\//i.test(route)) root = ctx.url.resolve(root, "../");
  }
  const result = ctx.url.resolve(root, route);
  if (ctx.url.parse(result).origin !== ctx.url.parse(base).origin)
    throw new ApiError(400, "请求路径不能改变站点 origin");
  return result;
}
export function headerName(name: string): string {
  if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)
      || /^(host|connection|content-length|transfer-encoding|upgrade|set-cookie|__proto__|constructor|prototype)$/i.test(name)
      || /^proxy-/i.test(name))
    throw new ApiError(400, "配置包含不允许的请求头");
  return name;
}
export function headerValue(value: string): string {
  if (/[\u0000-\u001f\u007f]/.test(value)) throw new ApiError(400, "请求头值不能包含控制字符");
  return value;
}
export function extra(settings: Settings): ObjectValue { return parseObject(settings.extraParams || "{}", "额外参数"); }

/** 解析 C# 的 Custom.fields.settings 形状，未配置的字段使用相同默认值。 */
export function settingsFrom(ctx: PluginContext, value: unknown): Settings {
  const raw = parseObject(value, "账号配置");
  const site = text(field(raw, "siteType"), "NewAPI").trim().toLowerCase();
  const siteType = site === "newapi" ? "NewAPI" : site === "sub2api" ? "Sub2API" : site === "custom" ? "Custom" : null;
  if (!siteType) throw new ApiError(400, "站点类型必须是 NewAPI、Sub2API 或 Custom");
  const apiKey = text(field(raw, "apiKey")).trim();
  if (!apiKey) throw new ApiError(400, "API Key 不能为空");
  const endpoints = modelIds(field(raw, "endpoints") ?? ENDPOINTS).map(value => "/" + value.replace(/^\/+|\/+$/g, ""));
  if (!endpoints.length || endpoints.some(value => !ENDPOINTS.includes(value.toLowerCase())))
    throw new ApiError(400, "至少选择一个有效的请求端点");
  const weight = field(raw, "weight") ?? 0;
  if (typeof weight !== "number" || !Number.isInteger(weight))
    throw new ApiError(400, "权重必须是整数");
  const params = parseObject(field(raw, "extraParams") ?? "{}", "额外参数");
  for (const name of ["enabled", "autoCheckIn"])
    if (field(raw, name) !== undefined && typeof field(raw, name) !== "boolean")
      throw new ApiError(400, `${name} 必须是布尔值`);
  for (const name of ["apiKeyHeader", "quotaApiKeyHeader"])
    if (params[name] !== undefined) headerName(text(params[name]));
  for (const name of ["loginPath", "checkInPath"])
    if (params[name] !== undefined) sitePath(text(params[name]));
  return {
    siteType, baseUrl: baseUrl(ctx, text(field(raw, "baseUrl"))), apiKey,
    username: text(field(raw, "username")), password: text(field(raw, "password")),
    weight: Math.max(0, Math.min(1000, weight)), endpoints,
    enabled: field(raw, "enabled") !== false, autoCheckIn: field(raw, "autoCheckIn") === true,
    extraParams: JSON.stringify(params)
  };
}
export function recordFrom(ctx: PluginContext, account: AccountMetadata, credential: Credential, version = account.credentialVersion): AccountRecord {
  if (credential.kind !== "Custom") throw new ApiError(400, "此插件只接受 Custom 凭据");
  return { account, credential, version, settings: settingsFrom(ctx, credential.fields.settings) };
}
/** 一次批量读取，避免 N 个账号消耗 N 次异步宿主调用。该结果不得直接送到页面。 */
export async function records(ctx: PluginContext, skipInvalid = false): Promise<AccountRecord[]> {
  const accounts = await ctx.accounts.list({ includeCredentials: true });
  return accounts.flatMap(account => {
    if (!account.credential) throw new ApiError(502, "宿主未返回凭证，请使用支持批量凭证读取的 Host API 1");
    try { return [recordFrom(ctx, account, account.credential)]; }
    catch (error) { if (!skipInvalid || !(error instanceof ApiError)) throw error; return []; }
  });
}
export async function readAccount(ctx: PluginContext, id: string): Promise<AccountRecord> {
  const account = await ctx.accounts.get(accountId(id));
  if (!account) throw new ApiError(404, "账号不存在");
  const saved = await ctx.accounts.readCredentials(id);
  return recordFrom(ctx, account, saved.credential, saved.version);
}
export function allowedModels(record: AccountRecord): string[] {
  return record.credential.fields.modelsConfigured?.toLowerCase() === "true"
    ? modelIds(storedJson(record.credential.fields.models)) : [];
}
/** 字段更新使用凭证 CAS，不覆盖并发写入的冷却/停用；冲突让管理员重新读取，不重复发上游请求。 */
export async function patchCredential(ctx: PluginContext, record: AccountRecord, fields: Record<string, string | null>): Promise<void> {
  const saved = await ctx.accounts.compareExchangeCredential(record.account.id, record.version, { kind: "Custom", fields });
  if (!saved) throw new ApiError(409, "账号已被其他操作修改，请刷新后重试");
}
/** 只有真实管理员端点能够批准 origin；模型、Cron、job 永远不会调用批准接口。 */
export async function authorize(ctx: PluginContext, settings: Settings, approve: unknown = false): Promise<void> {
  const origin = ctx.url.parse(settings.baseUrl).origin;
  const approved = await ctx.http.approvedOrigins();
  if (approved.includes(origin)) return;
  if (approve !== true) throw new ApiError(403, "请先明确勾选授权此站点，再获取模型；任务不会自动批准新域名");
  await ctx.http.approveOrigin(origin);
}
/** 构建 API/额度认证头，Messages 默认使用 x-api-key。 */
export function authHeaders(settings: Settings, endpoint?: string, quota = false): Record<string, string> {
  const params = extra(settings);
  const name = headerName(text(params[quota ? "quotaApiKeyHeader" : "apiKeyHeader"],
    !quota && endpoint?.toLowerCase() === "/v1/messages" ? "x-api-key" : "Authorization"));
  if (/^cookie$/i.test(name)) throw new ApiError(400, "API Key 不能使用 Cookie 请求头");
  const prefix = text(params[quota ? "quotaApiKeyPrefix" : "apiKeyPrefix"], name.toLowerCase() === "authorization" ? "Bearer " : "");
  return { [name]: headerValue(prefix + settings.apiKey) };
}
/** 管理请求完整缓冲；模型 POST 则使用 open，不能把两条路径的重试/所有权混用。 */
export async function requestText(ctx: PluginContext, spec: HttpRequest, client?: HttpClientHandle) {
  return (client ?? ctx.http).request({ route: "direct", timeoutMs: 30000, followRedirects: true, ...spec, responseType: "text" });
}
/** 诊断/页面错误脱敏；临时登录令牌及 Cookie 可通过 secrets 额外加入。 */
export function sanitize(value: unknown, settings?: Settings, secrets: string[] = []): string {
  let result = value instanceof Error ? value.message : text(value, "操作失败");
  const collect = (value: unknown, key = ""): string[] => typeof value === "string"
    ? /auth|api.?key|token|password|cookie|secret/i.test(key) && !/^(quota)?apiKey(Header|Prefix)$/i.test(key) && !/\{\{[a-z_]+\}\}/i.test(value) ? [value] : []
    : Array.isArray(value) ? value.flatMap(item => collect(item, key))
    : isObject(value) ? Object.entries(value).flatMap(([name, item]) => collect(item, name)) : [];
  const all = [settings?.apiKey, settings?.password, ...secrets, ...collect(settings ? storedJson(settings.extraParams) : null)]
    .filter((value): value is string => !!value);
  for (const secret of all) result = result.split(secret).join("[已隐藏]");
  return result.replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[已隐藏]").slice(0, 1200);
}
export function describe(status: number, body: string, settings: Settings, secrets: string[] = []): string {
  const parsed = storedJson(body);
  const message = text(field(parsed, "message"))
    || text(field(field(parsed, "error"), "message")) || text(field(parsed, "error"))
    || text(field(field(parsed, "data"), "message")) || body.trim() || `HTTP ${status}`;
  return sanitize(`HTTP ${status}: ${message}`, settings, secrets);
}
export function applicationError(body: unknown): boolean {
  if (!isObject(body)) return false;
  const code = field(body, "code"), error = field(body, "error");
  return field(body, "success") === false || (error !== undefined && error !== null && error !== false)
    || ((typeof code === "number" || typeof code === "string" && /^-?\d+$/.test(code)) && String(code) !== "0");
}
/** 只对已知业务错误返回详细说明；未知异常不暴露宿主/凭证，取消必须继续传播。 */
export function endpoint<T>(action: (ctx: PluginContext) => Promise<T>) {
  return async (ctx: PluginContext) => {
    try { return await action(ctx); }
    catch (error) {
      if (cancelled(error)) throw error;
      return ctx.json(error instanceof ApiError ? error.status : 502, {
        error: error instanceof ApiError ? error.message : "宿主操作失败，请检查权限、配额及日志"
      });
    }
  };
}
export async function log(ctx: PluginContext, eventType: string, message: string, account?: string, level: "Information" | "Warning" | "Error" = "Information") {
  try { await ctx.log.write({ eventType, message, accountId: account, level }); }
  catch { /* 诊断失败不能把已完成的签到/模型调用变成一次新的上游操作。 */ }
}
/**
 * 把 JSON 数字令牌转换为字符串再解析（字符串令牌原样保留）。
 * 用于额度/登录 UID，避免 Number 丢失 Int64 或十进制精度；最终仍由 JSON.parse 校验语法。
 */
export function losslessJson(source: string): unknown {
  return JSON.parse(source.replace(/"(?:\\.|[^"\\])*"|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/g,
    token => token.startsWith('"') ? token : JSON.stringify(token)));
}
/** 递归替换 JSON 模板的字符串值，不修改配置原对象；支持对象和任意层数组。 */
export function replaceTokens(value: unknown, tokens: Record<string, string>): Json {
  if (typeof value === "string")
    return value.replace(/\{\{([a-z_]+)\}\}/gi, (matched, name: string) => tokens[name.toLowerCase()] ?? matched);
  if (Array.isArray(value)) return value.map(item => replaceTokens(item, tokens));
  if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replaceTokens(item, tokens)]));
  return value === null || typeof value === "boolean" || typeof value === "number" ? value : null;
}
