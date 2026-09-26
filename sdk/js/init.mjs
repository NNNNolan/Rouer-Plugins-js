#!/usr/bin/env node
/**
 * @file 开发期脚手架：生成最小 TypeScript Echo 插件，不启动宿主，也不安装依赖。
 * 必须指定一个尚不存在的目标目录；父目录需已存在。CLI 默认以目录名作为 plugin id。
 * 生成项目通过 file: 相对依赖引用当前 SDK，因此移动 SDK/项目后应检查该引用是否仍有效。
 *
 * @example
 * node sdk/js/init.mjs ./my-plugin
 * node sdk/js/init.mjs ./workspace-folder custom-plugin-id
 */
import * as fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * 在新目录中创建 package.json、plugin.json、tsconfig.json 和 src/plugin.ts。
 * 默认 Echo 不调用真实上游；start 创建的 public 匿名账号仅用于满足宿主选号/租约契约。
 *
 * @param {string} directory 新开发目录；已存在时拒绝覆盖，包括已有的空目录。
 * @param {string} [id] 稳定插件标识，默认取目标目录名；安装目录也必须使用这个 id。
 * @returns {Promise<string>} 创建的项目绝对路径。
 * @throws {Error} id 不合法、目录已存在、父目录不存在或文件无法写入时失败。
 */
export async function initPlugin(directory, id = path.basename(path.resolve(directory))) {
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(id)) throw new Error("Use a lowercase plugin id.");
  const root = path.resolve(directory);
  // 故意不用 recursive:true：不能误把现有项目当成新项目覆盖。
  await fs.mkdir(root);
  await fs.mkdir(path.join(root, "src"));
  const sdk = path.relative(root, path.dirname(fileURLToPath(import.meta.url))).replaceAll("\\", "/");
  // 这里只写本地开发依赖；调用方随后显式 npm install，不在脚手架内部运行第三方安装脚本。
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({
    name: id, private: true, type: "module",
    scripts: { build: "router2api-plugin-build .", check: "tsc --noEmit" },
    devDependencies: { "@router2api/plugin-sdk": `file:${sdk}`, typescript: "5.9.3" }
  }, null, 2) + "\n");
  await fs.writeFile(path.join(root, "plugin.json"), JSON.stringify({
    schemaVersion: 1, id, name: id, version: "1.0.0", runtime: "jint", hostApi: "1", format: "esm-bundle",
    entry: "src/plugin.ts", platform: { name: id, credentialKinds: ["ApiKey"] },
    hooks: { invoke: "invoke", getModels: "getModels", start: "start" },
    permissions: { createAnonymousAccount: true }, policy: { maxAttempts: 1 }
  }, null, 2) + "\n");
  await fs.writeFile(path.join(root, "tsconfig.json"), JSON.stringify({
    // 类型检查独立于构建：esbuild 负责转换/打包，tsc --noEmit 负责类型错误。
    compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "Bundler", strict: true, noEmit: true },
    include: ["src"]
  }, null, 2) + "\n");
  await fs.writeFile(path.join(root, "src", "plugin.ts"), `import type { PluginContext } from "@router2api/plugin-sdk";
/**
 * 启动钩子：保存宿主挑选账号所需的匿名记录。
 * 必须 await 宿主操作；不要依赖本次 Engine 的模块变量传给下一次调用。
 */
export async function start(ctx: PluginContext) { await ctx.accounts.ensureAnonymous(); }
/** 返回不带平台前缀的模型 ID；对外路由由宿主组成 <platform>/echo。 */
export function getModels() { return [{id:"echo",displayName:"Echo",supportsStreaming:true}]; }
/**
 * 模型入口只返回统一 completion，不手工拼装公共协议/SSE。
 * Terminal 阶段一定有 request；宿主会按下游请求决定输出 JSON 还是标准流。
 */
export function invoke(ctx: PluginContext) {
  return ctx.reply.completion({model:ctx.request!.model,content:"Hello from Jint",finishReason:"stop"});
}
`);
  return root;
}
// 作为模块被测试 import 时不创建目录；只有直接调用 CLI 才执行脚手架。
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    if (!process.argv[2]) throw new Error("Usage: router2api-plugin-init <new-directory> [plugin-id]");
    console.log(await initPlugin(process.argv[2], process.argv[3]));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
