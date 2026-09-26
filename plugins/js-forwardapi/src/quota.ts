/**
 * NewAPI/Sub2API 额度适配。金额始终以十进制字符串计算/保存，不让 JS Number 做财务运算。
 * 展示层可格式化数值，但不能将显示值作为新的额度事实写回。
 */
import type { PluginContext } from "../../../sdk/js/index";
import {
  ApiError, accountId, applicationError, authHeaders, buildUrl, cancelled, describe, field, input,
  isObject, log, losslessJson, patchCredential, readAccount, requestText, text, type Settings
} from "./common";

type Amount = string | null;
export interface Quota {
  total: Amount;
  used: Amount;
  remaining: Amount;
  unlimited: boolean;
  unit: string;
  updatedAt: string;
}
/** 科学计数法先按字符展开，再交给 .NET decimal；拒绝超大指数，不分配巨大字符串。 */
function decimal(ctx: PluginContext, value: unknown): Amount {
  if (typeof value !== "string" && typeof value !== "number") return null;
  let raw = String(value).replace(/,/g, "");
  const match = /^(-?)(\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/.exec(raw);
  if (match) {
    const exponent = Number(match[4]);
    if (!Number.isInteger(exponent) || Math.abs(exponent) > 100) return null;
    const digits = match[2] + (match[3] ?? ""), point = match[2].length + exponent;
    raw = match[1] + (point <= 0 ? "0." + "0".repeat(-point) + digits
      : point >= digits.length ? digits + "0".repeat(point - digits.length)
      : digits.slice(0, point) + "." + digits.slice(point));
  }
  try { return ctx.decimal.add(raw, "0"); } catch { return null; }
}
function number(ctx: PluginContext, object: unknown, ...names: string[]): Amount {
  for (const name of names) {
    const value = decimal(ctx, field(object, name));
    if (value !== null) return value;
  }
  return null;
}
const boolean = (object: unknown, ...names: string[]): boolean =>
  names.some(name => field(object, name) === true || text(field(object, name)).toLowerCase() === "true");
const nonnegative = (ctx: PluginContext, amount: string): string => ctx.decimal.compare(amount, "0") < 0 ? "0" : amount;

/** 同 C#：周期订阅与使用比例最紧的 rate limit 可补充缺失字段。 */
export function parseQuota(ctx: PluginContext, settings: Settings, payload: unknown, status?: unknown): Quota {
  const data = isObject(field(payload, "data")) ? field(payload, "data") : payload;
  const nested = isObject(field(data, "quota")) ? field(data, "quota") : data;
  let total = number(ctx, data, "total_granted", "quota", "total", "limit", "quota_limit")
    ?? number(ctx, nested, "total_granted", "total", "limit", "quota_limit");
  let used = number(ctx, data, "total_used", "used_quota", "used", "quota_used")
    ?? number(ctx, nested, "total_used", "used_quota", "used", "quota_used");
  let remaining = number(ctx, data, "total_available", "remaining_quota", "remaining", "available", "quota_remaining")
    ?? number(ctx, nested, "total_available", "remaining_quota", "remaining", "available", "quota_remaining");
  let unlimited = boolean(data, "unlimited_quota", "unlimited");
  if (settings.siteType === "Sub2API") {
    if (remaining !== null && ctx.decimal.compare(remaining, "0") < 0) { unlimited = true; remaining = null; }
    const subscription = field(data, "subscription");
    for (const window of ["monthly", "weekly", "daily"]) {
      const limit = number(ctx, subscription, `${window}_limit_usd`);
      if (limit !== null && ctx.decimal.compare(limit, "0") > 0) {
        total ??= limit;
        used ??= number(ctx, subscription, `${window}_usage_usd`);
        break;
      }
    }
    let tightest: { total: string; used: string; remaining: string; ratio: string } | undefined;
    const limits = field(data, "rate_limits");
    for (const item of Array.isArray(limits) ? limits : []) {
      let t = number(ctx, item, "limit", "total"), u = number(ctx, item, "used"), r = number(ctx, item, "remaining", "available");
      if (t === null && u !== null && r !== null) t = ctx.decimal.add(u, r);
      if (t === null || ctx.decimal.compare(t, "0") <= 0 || u === null && r === null) continue;
      u ??= nonnegative(ctx, ctx.decimal.subtract(t, r!));
      r ??= nonnegative(ctx, ctx.decimal.subtract(t, u));
      const ratio = ctx.decimal.divide(u, t);
      if (!tightest || ctx.decimal.compare(ratio, tightest.ratio) > 0) tightest = { total: t, used: u, remaining: r, ratio };
    }
    total ??= tightest?.total ?? null;
    used ??= tightest?.used ?? null;
    if (!unlimited) remaining ??= tightest?.remaining ?? null;
    used ??= number(ctx, field(field(data, "usage"), "total"), "cost");
  }
  if (!unlimited && remaining === null && total !== null && used !== null)
    remaining = nonnegative(ctx, ctx.decimal.subtract(total, used));
  if (!unlimited && total === null && used !== null && remaining !== null) total = ctx.decimal.add(used, remaining);
  if (total === null && used === null && remaining === null && !unlimited)
    throw new ApiError(502, "上游响应中没有可识别的额度字段");
  let unit = text(field(data, "currency")) || text(field(data, "unit")) || (settings.siteType === "Sub2API" ? "USD" : "额度");
  if (settings.siteType === "NewAPI") {
    const info = isObject(field(status, "data")) ? field(status, "data") : status;
    const perUnit = number(ctx, info, "quota_per_unit");
    if (boolean(info, "display_in_currency") && perUnit !== null && ctx.decimal.compare(perUnit, "0") > 0) {
      total = total === null ? null : ctx.decimal.divide(total, perUnit);
      used = used === null ? null : ctx.decimal.divide(used, perUnit);
      remaining = remaining === null ? null : ctx.decimal.divide(remaining, perUnit);
      const currency = text(field(info, "quota_display_type")) || text(field(info, "custom_currency_symbol")) || text(field(info, "currency"));
      unit = ["CNY", "RMB"].includes(currency.toUpperCase()) ? "¥" : currency.toUpperCase() === "USD" ? "$" : currency || "余额";
    }
  }
  return { total, used, remaining, unlimited, unit, updatedAt: new Date().toISOString() };
}
export async function fetchQuota(ctx: PluginContext, settings: Settings): Promise<Quota> {
  if (settings.siteType === "Custom") throw new ApiError(400, "通用 API 没有标准额度接口");
  const path = settings.siteType === "NewAPI" ? "/api/usage/token" : "/v1/usage";
  let response = await requestText(ctx, { url: buildUrl(ctx, settings.baseUrl, path), headers: authHeaders(settings, undefined, true) });
  if ([404, 405].includes(response.statusCode))
    response = await requestText(ctx, { url: buildUrl(ctx, settings.baseUrl, path + "/"), headers: authHeaders(settings, undefined, true) });
  if (response.statusCode < 200 || response.statusCode >= 300)
    throw new ApiError(502, describe(response.statusCode, response.bodyText, settings));
  let payload: unknown;
  try { payload = losslessJson(response.bodyText); }
  catch { throw new ApiError(502, "上游额度响应不是有效 JSON"); }
  if (applicationError(payload)) throw new ApiError(502, describe(response.statusCode, response.bodyText, settings));
  let status: unknown;
  if (settings.siteType === "NewAPI") {
    try {
      const result = await requestText(ctx, { url: buildUrl(ctx, settings.baseUrl, "/api/status") });
      if (result.statusCode >= 200 && result.statusCode < 300) status = losslessJson(result.bodyText);
    } catch (error) { if (cancelled(error)) throw error; /* 单位查询失败不篡改已取得的额度事实。 */ }
  }
  return parseQuota(ctx, settings, payload, status);
}
export async function refreshQuota(ctx: PluginContext) {
  const record = await readAccount(ctx, accountId(field(input(ctx), "id")));
  const quota = await fetchQuota(ctx, record.settings);
  await patchCredential(ctx, record, {
    ...record.credential.fields, quotaSnapshot: JSON.stringify(quota), quotaUpdatedAt: quota.updatedAt
  });
  await log(ctx, "quota.refresh.succeeded", "额度已刷新", record.account.id);
  return ctx.json(200, { quota });
}
