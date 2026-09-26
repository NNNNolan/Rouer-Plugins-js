/**
 * 无网络的教学插件：演示最小模型、管理端点、local state、Cron 和可取消 job。
 * 只导入开发期类型；构建产物没有 SDK 运行时依赖，ctx 由宿主注入。
 * 从仓库根目录执行：node sdk/js/build.mjs plugins/tutorial-echo
 */
import type { InvocationResult, Json, ModelDescriptor, PluginContext } from "../../../sdk/js/index";

/** 示例状态最多保存一天；local state 在版本替换后重新开始，不是永久业务数据。 */
const STATE_TTL = { ttlSeconds: 86400 };

/**
 * 候选版本启动：创建匿名账号供宿主选号/租约使用，并记录启动时间。
 * 只会写本插件的教学账号和本代状态，不联网；不重置已被管理员停用的账号。
 * start 发生在新平台发布前，因此不能在这里依赖 models.refresh 查询新终端。
 */
export async function start(ctx: PluginContext): Promise<void> {
  await ctx.accounts.ensureAnonymous();
  await ctx.state.local.set("started-at", new Date().toISOString(), STATE_TTL);
}

/** 返回平台内部模型 ID；宿主对外发布为 tutorial-echo/echo，不在这里重复添加前缀。 */
export function getModels(): ModelDescriptor[] {
  return [{ id: "echo", displayName: "教程 Echo（不访问上游）", supportsStreaming: true }];
}

/**
 * 回显最后一条普通文本消息，公共协议的 JSON/SSE 包装交给宿主。
 * 这不是 AI 模型适配器：明确拒绝工具/内容块，不假装处理图片、文件或推理。
 * supportsStreaming 表示宿主可把完成对象转换为流，不代表这里建立了上游 SSE。
 */
export function invoke(ctx: PluginContext): InvocationResult {
  const request = ctx.request!;
  if (request.model !== "echo")
    return ctx.reply.error(404, "教程只提供 echo 模型", { failureKind: "Plugin", reasonCode: "tutorial.unknown_model" });
  if (request.tools.length || request.messages.some(message => message.contentParts?.length))
    return ctx.reply.error(400, "教程只接受普通文本消息，不处理工具或内容块", {
      failureKind: "Plugin", reasonCode: "tutorial.unsupported_input"
    });
  return ctx.reply.completion({
    model: request.model,
    content: `Jint Echo: ${request.messages.at(-1)?.content ?? ""}`,
    finishReason: "stop"
    // 没有调用上游，不编造 token 用量或已扣费积分。
  });
}

/**
 * 管理页快照：只返回版本和演示状态，不返回凭据。
 * 三个独立只读操作可并行等待；必须 await，不遗留宿主操作到函数返回之后。
 */
export async function getStatus(ctx: PluginContext) {
  const [startedAt, tickCount, lastTickAt] = await Promise.all([
    ctx.state.local.get("started-at"),
    ctx.state.local.getString("tick-count"),
    ctx.state.local.get("last-tick-at")
  ]);
  return ctx.json(200, {
    platform: ctx.platform, version: ctx.pluginVersion, generation: ctx.generationId,
    startedAt, tickCount: tickCount ?? "0", lastTickAt
  });
}

/**
 * 从不可信 JSON 读取有界步数；HTTP 端点和 job 入口都验证，避免其他入口绕过。
 * 返回 null 表示非法输入，不通过 Number(...) 把字符串/空值默认为有效参数。
 */
function readSteps(input: unknown): number | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const steps = (input as { steps?: unknown }).steps;
  return typeof steps === "number" && Number.isInteger(steps) && steps >= 1 && steps <= 20 ? steps : null;
}

/**
 * POST jobs/start，正文 {"steps":8}：入队后立即返回 202，不等待任务完成。
 * 同 key 的活跃任务会复用旧任务，后来的 steps 不覆盖其输入；结束后可再次创建。
 */
export async function startJob(ctx: PluginContext) {
  const steps = readSteps(ctx.body);
  if (steps === null) return ctx.json(400, { error: "steps 必须是 1–20 的整数" });
  const job = await ctx.jobs.start("demo-progress", { steps }, { key: "tutorial-progress" });
  return ctx.json(202, job);
}

/**
 * GET jobs/status?id=...：ID 是宿主生成的不透明标识，只能查询当前插件版本。
 * 不存在/重载后失效/历史过期都返回 404；不把 null 当作“任务成功”。
 */
export async function getJob(ctx: PluginContext) {
  const id = ctx.query?.id;
  if (!id || id.length > 128) return ctx.json(400, { error: "请提供有效的任务 id" });
  const job = await ctx.jobs.get(id);
  return job ? ctx.json(200, job) : ctx.json(404, { error: "任务不存在、已过期或不属于当前版本" });
}

/**
 * POST jobs/cancel，正文 {"id":"..."}：仅发出取消请求。
 * accepted 不等于已退出；页面仍需查询最终的 Cancelled/Completed/Failed 状态。
 */
export async function cancelJob(ctx: PluginContext) {
  const body = ctx.body;
  const id = body && typeof body === "object" && !Array.isArray(body) ? body.id : undefined;
  if (typeof id !== "string" || !id || id.length > 128)
    return ctx.json(400, { error: "请提供有效的任务 id" });
  return ctx.json(200, { accepted: await ctx.jobs.cancel(id) });
}

/**
 * 命名 job 在独立 Engine 中运行；输入必须可序列化，不捕获发起请求的 ctx/账号/source。
 * delay 使用宿主取消令牌，取消/超时会拒绝 Promise；不 catch 后伪造 Completed。
 * 进度与结果明确标记为教学演示，不能当作真实签到、充值或余额刷新结果。
 */
export async function demoProgress(ctx: PluginContext, input: Json): Promise<Json> {
  const steps = readSteps(input);
  if (steps === null) throw new Error("steps 必须是 1–20 的整数");
  await ctx.jobs.progress({ completed: 0, total: steps, message: "演示开始" });
  for (let completed = 1; completed <= steps; completed++) {
    await ctx.delay(250);
    await ctx.jobs.progress({ completed, total: steps, message: "演示进度，不调用上游" });
  }
  return { demo: true, completed: steps, finishedAt: new Date().toISOString() };
}

/**
 * Cron 每小时触发，经宿主原生任务锁执行；首次加载并不会立刻触发。
 * 只更新 local 演示计数。计数使用精确字符串读取，不经过可能失真的 JSON Number。
 * 如从 jobs.start("hourly-tick") 运行，结果由宿主返回 succeeded，而不是此函数返回值。
 */
export async function hourlyTick(ctx: PluginContext): Promise<void> {
  await ctx.state.local.increment("tick-count", "1", STATE_TTL);
  await ctx.state.local.set("last-tick-at", new Date().toISOString(), STATE_TTL);
}
