/**
 * 手动/Cron/job 共用的一次签到逻辑。
 * 不开启 POST 传输重试，不自动批准域名，不因 401/429 更新账号或代理惩罚。
 */
import type { HttpClientHandle, Json, PluginContext } from "../../../sdk/js/index";
import {
  ApiError, accountId, applicationError, buildUrl, cancelled, describe, extra, field, headerName,
  headerValue, input, isObject, log, losslessJson, readAccount, records, replaceTokens, requestText,
  sanitize, sitePath, text, type AccountRecord
} from "./common";

export interface CheckInResult {
  accountId: string;
  label: string;
  status: "Success" | "Already" | "Skipped" | "Failed";
  message: string;
  statusCode?: number;
  error?: string;
}
interface SiteResult { statusCode: number; bodyText: string; body: unknown; success: boolean; cookies: string; error?: string }

/** 合并显式 Cookie，后出现的同名 Cookie 覆盖前值；不创建跨账号 Cookie 容器。 */
export function mergeCookies(...values: string[]): string {
  const cookies = new Map<string, string>();
  for (const value of values) for (const pair of value.split(";")) {
    const index = pair.indexOf("=");
    if (index > 0) cookies.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
  }
  return [...cookies].map(([name, value]) => `${name}=${value}`).join("; ");
}
/** 大小写统一后再检查 Authorization，避免重复认证头；模板替换只作用于值。 */
function headers(value: unknown, tokens: Record<string, string>): Record<string, string> {
  if (!isObject(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string")
    .map(([name, value]) => [headerName(name).toLowerCase(), headerValue(replaceTokens(value, tokens) as string)]));
}
async function sendSite(ctx: PluginContext, record: AccountRecord, client: HttpClientHandle, path: string, method: string,
  body: unknown, custom: unknown, tokens: Record<string, string>, secrets: string[], authenticate: boolean): Promise<SiteResult> {
  const verb = method.trim().toUpperCase();
  if (verb !== "GET" && verb !== "POST" && verb !== "PUT") throw new ApiError(400, "签到 method 只支持 GET、POST 或 PUT");
  const requestHeaders = headers(custom, tokens);
  const settings = record.settings;
  requestHeaders.accept ??= "application/json, text/plain, */*";
  requestHeaders.origin ??= ctx.url.parse(settings.baseUrl).origin;
  requestHeaders.referer ??= settings.baseUrl + "/";
  requestHeaders["user-agent"] ??= "Mozilla/5.0 Router2API/1.0";
  if (tokens.user_id) requestHeaders["new-api-user"] ??= headerValue(tokens.user_id);
  const token = tokens.access_token || (authenticate ? settings.apiKey : "");
  if (token) requestHeaders.authorization ??= headerValue("Bearer " + token.replace(/^Bearer\s+/i, ""));
  const result = await requestText(ctx, {
    url: buildUrl(ctx, settings.baseUrl, sitePath(path)), method: verb, headers: requestHeaders,
    body: verb === "GET" ? undefined : replaceTokens(isObject(body) ? body : {}, tokens)
  }, client);
  let parsed: unknown;
  try { parsed = losslessJson(result.bodyText); } catch { /* 非 JSON 签到响应不能被判定为成功。 */ }
  const success = result.statusCode >= 200 && result.statusCode < 300 && !applicationError(parsed);
  const cookies = (result.headers["set-cookie"] ?? []).map(value => value.split(";", 1)[0]).join("; ");
  return {
    statusCode: result.statusCode, bodyText: result.bodyText, body: parsed, success, cookies,
    error: success ? undefined : describe(result.statusCode, result.bodyText, settings, secrets)
  };
}
/** 保留 C# 对已签到、奖励字段和未知响应的解释，不将任意 HTTP 200 当签到成功。 */
export function interpret(record: AccountRecord, response: SiteResult): CheckInResult {
  const result = (status: CheckInResult["status"], message: string): CheckInResult => ({
    accountId: record.account.id, label: record.account.label || record.account.id,
    status, message, statusCode: response.statusCode, ...(status === "Failed" ? { error: message } : {})
  });
  if (response.statusCode < 200 || response.statusCode >= 300) return result("Failed", response.error || `HTTP ${response.statusCode}`);
  if (!isObject(response.body)) return result("Failed", "签到响应不是有效 JSON 对象");
  const body = response.body, message = text(field(body, "message")).trim();
  if (/已签到|已经签到|already checked in|already signed in|checked in today/i.test(message))
    return result("Already", message || "今日已签到");
  const hasReward = [body, field(body, "data")].some(value =>
    ["quota_awarded", "checkin_quota", "check_in_quota", "checkin_reward", "reward"]
      .some(name => field(value, name) !== undefined && field(value, name) !== null));
  const success = field(body, "success"), error = field(body, "error"), code = field(body, "code");
  if (error != null && error !== false && success !== true)
    return result("Failed", text(field(error, "message")) || text(error) || "签到返回业务错误");
  if (success === true) return result(!message && !hasReward ? "Already" : "Success", message || (hasReward ? "签到成功" : "今日已签到"));
  if (success === false || code != null && /^-?\d+$/.test(String(code)) && String(code) !== "0")
    return result("Failed", message || `签到失败，code=${String(code ?? "")}`);
  if (hasReward || /签到成功|success/i.test(message)) return result("Success", message || "签到成功");
  return result("Failed", message || "签到响应无法识别");
}
async function execute(ctx: PluginContext, record: AccountRecord, secrets: string[]): Promise<CheckInResult> {
  const settings = record.settings, params = extra(settings);
  const paths = text(params.checkInPath) ? [sitePath(text(params.checkInPath))]
    : settings.siteType === "NewAPI" ? ["/api/user/checkin", "/api/user/sign_in"] : [];
  const outcome = (status: CheckInResult["status"], message: string): CheckInResult =>
    ({ accountId: record.account.id, label: record.account.label || record.account.id, status, message });
  if (!paths.length) return outcome("Skipped", "Sub2API/Custom 未配置签到路径，不猜测接口");
  const client = await ctx.http.createClient({ route: "direct" });
  try {
    const tokens = { username: settings.username, password: settings.password, access_token: settings.apiKey, token: settings.apiKey, user_id: "" };
    let cookies = "";
    if (settings.siteType === "NewAPI" || text(params.loginPath)) {
      if (!settings.username || !settings.password) return outcome("Failed", "签到需要站点用户名和密码");
      const login = await sendSite(ctx, record, client, text(params.loginPath, "/api/user/login"),
        text(params.loginMethod, "POST"), params.loginBody ?? { username: "{{username}}", password: "{{password}}" },
        params.loginHeaders, { ...tokens, access_token: "", token: "" }, secrets, false);
      if (!login.success) return outcome("Failed", login.error || "登录失败");
      const data = field(login.body, "data");
      tokens.access_token = text(field(data, "access_token")) || text(field(data, "token"))
        || text(field(login.body, "access_token")) || text(field(login.body, "token"));
      tokens.token = tokens.access_token;
      tokens.user_id = text(field(field(data, "user"), "id")) || text(field(data, "id"));
      cookies = login.cookies;
      secrets.push(tokens.access_token, cookies, ...cookies.split(";").map(value => value.slice(value.indexOf("=") + 1).trim()));
      if (!tokens.access_token && !cookies) return outcome("Failed", "登录响应没有返回 token 或 Set-Cookie");
    }
    const customHeaders = headers(params.checkInHeaders, tokens);
    if (cookies) customHeaders.cookie = mergeCookies(customHeaders.cookie ?? "", cookies);
    let result: CheckInResult | undefined;
    for (const path of paths) {
      const response = await sendSite(ctx, record, client, path, text(params.checkInMethod, "POST"),
        params.checkInBody ?? {}, customHeaders, tokens, secrets, true);
      result = interpret(record, response);
      // 只在路径不存在/不支持方法时尝试备用地址，超时和普通业务失败不重放 POST。
      if (result.status !== "Failed" || !([404, 405].includes(response.statusCode) || /Invalid URL|不存在/i.test(response.bodyText)))
        return result;
    }
    return result ?? outcome("Failed", "没有可用的签到路径");
  } finally { await client.close(); }
}
/** 每个入口共用这一层脱敏和日志，任务取消继续抛给宿主，不能伪造 Success。 */
export async function checkIn(ctx: PluginContext, record: AccountRecord, taskName: string): Promise<CheckInResult> {
  const startedAt = new Date().toISOString(), start = Date.now(), secrets: string[] = [];
  let result: CheckInResult;
  try { result = await execute(ctx, record, secrets); }
  catch (error) {
    if (cancelled(error)) throw error;
    const message = sanitize(error, record.settings, secrets);
    result = { accountId: record.account.id, label: record.account.label || record.account.id, status: "Failed", message, error: message };
  }
  result.message = sanitize(result.message, record.settings, secrets);
  if (result.error) result.error = sanitize(result.error, record.settings, secrets);
  await log(ctx, `checkin.${result.status.toLowerCase()}`, result.message, record.account.id,
    result.status === "Failed" ? "Error" : result.status === "Skipped" ? "Warning" : "Information");
  try {
    await ctx.tasks.writeLog({
      taskName, accountId: record.account.id, status: result.status, message: result.message, error: result.error,
      startedAt, finishedAt: new Date().toISOString(), durationMs: Date.now() - start,
      details: { statusCode: result.statusCode ?? null }
    });
  } catch { /* 任务总体取消/结束由原生 runner/job manager 记录，不重跑已经完成的签到。 */ }
  return result;
}
/** 保留同步管理接口；长操作建议使用 checkin/start，不占用管理 HTTP 生命周期。 */
export async function runCheckIn(ctx: PluginContext) {
  const record = await readAccount(ctx, accountId(field(input(ctx), "id")));
  const result = await checkIn(ctx, record, "js-forwardapi-manual-checkin");
  return ctx.json(result.status === "Failed" ? 502 : 200, result);
}
export async function startCheckIn(ctx: PluginContext) {
  const id = accountId(field(input(ctx), "id"));
  await readAccount(ctx, id);
  return ctx.json(202, await ctx.jobs.start("js-forwardapi-checkin", { id }, { key: `checkin:${id}` }));
}
export async function checkInJob(ctx: PluginContext, payload: Json): Promise<Json> {
  const id = accountId(field(payload, "id"));
  await ctx.jobs.progress({ stage: "checkin", accountId: id });
  const result = await checkIn(ctx, await readAccount(ctx, id), "js-forwardapi-manual-checkin");
  return { ...result };
}
export async function dailyCheckIn(ctx: PluginContext): Promise<void> {
  const accounts = (await records(ctx, true)).filter(item => item.settings.enabled && item.settings.autoCheckIn
    && !["Disabled", "Invalid", "Removed"].includes(item.account.status.state));
  for (const record of accounts) await checkIn(ctx, record, "js-forwardapi-daily-checkin");
  await log(ctx, "checkin.task.completed", `每日签到已处理 ${accounts.length} 个账号`);
}
export async function jobStatus(ctx: PluginContext) {
  const id = ctx.query?.id;
  if (!id || id.length > 128) throw new ApiError(400, "任务 ID 无效");
  const job = await ctx.jobs.get(id);
  if (!job) throw new ApiError(404, "任务不存在、已过期或不属于当前插件版本");
  return ctx.json(200, job);
}
export async function cancelJob(ctx: PluginContext) {
  const id = field(input(ctx), "id");
  if (typeof id !== "string" || !id || id.length > 128) throw new ApiError(400, "任务 ID 无效");
  return ctx.json(200, { accepted: await ctx.jobs.cancel(id) });
}
