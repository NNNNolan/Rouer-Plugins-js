/**
 * JS ForwardAPI 的公开入口：提供方协议留在插件，选号/动作执行/流所有权留给宿主。
 * 相比 C# 版本，原始 JSON 使用宿主句柄编辑，跨调用状态/账号由 ctx 管理。
 */
import type { AttemptDecision, Completion, InvocationResult, PluginContext } from "../../../sdk/js/index";
import * as accounts from "./accounts";
import * as checkin from "./checkin";
import { refreshQuota as refreshQuotaCore } from "./quota";
import {
  ApiError, authHeaders, buildUrl, cancelled, describe, endpoint, extra, field, headerName, headerValue,
  log, recordFrom, replacementHeaders, sanitize, storedJson, type Settings
} from "./common";

export { getModels, selectAccounts, validateCredential } from "./accounts";
export { dailyCheckIn, checkInJob } from "./checkin";
export const listAccounts = endpoint(accounts.listAccounts);
export const saveAccount = endpoint(accounts.saveAccount);
export const deleteAccount = endpoint(accounts.deleteAccount);
export const discoverModels = endpoint(accounts.discoverModels);
export const refreshModels = endpoint(accounts.refreshModels);
export const refreshQuota = endpoint(refreshQuotaCore);
export const runCheckIn = endpoint(checkin.runCheckIn);
export const startCheckIn = endpoint(checkin.startCheckIn);
export const jobStatus = endpoint(checkin.jobStatus);
export const cancelJob = endpoint(checkin.cancelJob);
export const listOrigins = endpoint(accounts.listOrigins);
export const revokeOrigin = endpoint(accounts.revokeOrigin);

/** 单次业务决策，与 C# 的状态规则一致；这里不先写账号状态，也不处罚直连之外的代理。 */
export function decision(status: number | undefined, message: string, transport = false): AttemptDecision {
  const disable = status === 401 || status === 403 && /invalid|unauthorized|credential/i.test(message);
  const cooldown = !disable && (transport || status === 429 || status !== undefined && status >= 500);
  return {
    // 独立 direct 工厂不提供 attempt 代理证据，不伪造 Transport 标志或代理 407。
    failureKind: disable ? "InvalidCredential" : "Upstream",
    retry: disable || transport || status === 408 || status === 425 || status === 429 || status !== undefined && status >= 500 ? "NextAttempt" : "None",
    accountAction: disable ? "Disable" : cooldown ? "Cooldown" : "None",
    ...(cooldown ? { accountCooldownUntil: new Date(Date.now() + 300000).toISOString() } : {}),
    proxyAction: "None", reasonCode: "js-forwardapi.upstream"
  };
}
/** 缓冲原始响应只读取 usage 供统计；不重新 stringify 响应，不伪造无法确定的 token 用量。 */
function usage(ctx: PluginContext, base64: string): Completion["usage"] | undefined {
  if (base64.length > 750000) return undefined; // 同步工具输入有 1 MiB 预算，不为统计破坏大正文透传。
  try {
    const body = storedJson(ctx.encoding.fromBase64(base64)), raw = field(body, "usage");
    if (!raw) return undefined;
    const promptTokens = field(raw, "prompt_tokens") ?? field(raw, "input_tokens") ?? 0;
    const completionTokens = field(raw, "completion_tokens") ?? field(raw, "output_tokens") ?? 0;
    if (typeof promptTokens !== "number" || typeof completionTokens !== "number") return undefined;
    const totalTokens = field(raw, "total_tokens") ?? promptTokens + completionTokens;
    if (![promptTokens, completionTokens, totalTokens].every(value => typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 2147483647))
      return undefined;
    return { promptTokens, completionTokens, totalTokens: totalTokens as number };
  } catch { return undefined; }
}
export async function invoke(ctx: PluginContext): Promise<InvocationResult> {
  let settings: Settings | undefined;
  try {
    if (!ctx.request?.originalBodyRef || !ctx.account) throw new ApiError(400, "缺少宿主原始请求句柄或当前账号");
    const record = recordFrom(ctx, ctx.account, await ctx.accounts.currentCredential());
    settings = record.settings;
    if (!accounts.eligible(record, ctx)) throw new ApiError(400, "账号未启用当前模型或端点");
    const headers: Record<string, string> = Object.fromEntries(Object.entries(ctx.request.headers)
      .filter(([name]) => !/^(content-type|authorization|x-api-key|cookie|set-cookie)$/i.test(name))
      .map(([name, value]) => [headerName(name).toLowerCase(), headerValue(value)]));
    // 先去掉由账号控制的认证头，避免下游 x-* 自定义头覆盖当前账号的密钥。
    for (const [name, value] of Object.entries(authHeaders(settings, ctx.request.endpoint))) headers[name.toLowerCase()] = value;
    if (ctx.request.endpoint.toLowerCase() === "/v1/messages") headers["anthropic-version"] ??= "2023-06-01";
    // 管理员按上游账号配置的替换项最后应用，也可新增下游未携带的请求头。
    Object.assign(headers, replacementHeaders(extra(settings)));
    const source = await ctx.http.open({
      method: "POST", route: "direct", url: buildUrl(ctx, settings.baseUrl, ctx.request.endpoint),
      headers, followRedirects: false,
      originalJson: {
        source: ctx.request.originalBodyRef, remove: ["endpoint", "overrides", "models"], set: { model: ctx.request.model }
      }
    });
    if (source.statusCode < 200 || source.statusCode >= 300) {
      const snapshot = source.statusCode >= 400 ? (await ctx.http.snapshotError(source.handle)).text : "";
      const bodyBase64 = await ctx.http.readBase64(source.handle); // 消费/关闭，不把错误响应当作流移交阻止业务重试。
      const message = describe(source.statusCode, snapshot, settings);
      await log(ctx, "request.upstream.failed", message, ctx.account.id, "Error");
      return {
        response: { kind: "raw", statusCode: source.statusCode, bodyBase64, contentType: source.contentType },
        attempt: { decision: decision(source.statusCode, message), statusCode: source.statusCode, reason: message }
      };
    }
    if (ctx.request.stream || /text\/event-stream/i.test(source.contentType)) {
      // 移交后绝不读取/关闭 source；宿主负责直到最后字节、取消或失败，再回收引擎和 HTTP。
      return ctx.reply.raw(source);
    }
    const bodyBase64 = await ctx.http.readBase64(source.handle);
    return {
      response: { kind: "raw", statusCode: source.statusCode, bodyBase64, contentType: source.contentType, usage: usage(ctx, bodyBase64) },
      attempt: { decision: { failureKind: "None" }, statusCode: source.statusCode }
    };
  } catch (error) {
    if (cancelled(error)) throw error;
    const code = field(error, "code");
    if (code === "host.http_error") {
      const message = "直连上游发生传输错误";
      return ctx.reply.error(502, message, decision(undefined, message, true));
    }
    // 权限、形状、缓冲/脚本错误不惩罚账号，也不重放可能已经生成过的请求。
    return ctx.reply.error(error instanceof ApiError ? error.status : 502,
      error instanceof ApiError ? sanitize(error, settings) : "插件操作失败，请检查 origin 权限或宿主资源预算",
      { failureKind: "Plugin", reasonCode: "js-forwardapi.invalid_operation" });
  }
}
