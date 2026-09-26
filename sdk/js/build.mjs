#!/usr/bin/env node
/**
 * @file JS/TS 插件的开发期打包器，不在 Jint 生产宿主中运行。
 *
 * 调用链：读取清单 → 校验入口/页面 → esbuild 生成单文件 ESM → 核对导出 →
 * 写入 server/plugin.mjs、可选 ui/index.html 和规范化的 plugin.json。
 * 此处只做静态构建，不 import/执行用户插件，不运行 start、job 或安装脚本。
 * 最终的权限、函数类型、Cron、生命周期等仍以宿主加载器校验为准。
 *
 * @example
 * node sdk/js/build.mjs ./my-plugin
 * node sdk/js/build.mjs ./my-plugin ./artifacts/plugins/my-plugin
 */
import { build } from "esbuild";
import * as fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * 判断目标是否严格位于目录内部；目录本身、祖先和其他盘符都不算内部。
 * 使用 path.relative 而不是字符串前缀，避免把 /plugins-a 当成 /plugins 的子目录。
 * @param {string} root 已解析的目录绝对路径。
 * @param {string} file 待检查的文件/目录绝对路径。
 * @returns {boolean} 是否为 root 的后代路径。
 */
const within = (root, file) => {
  const relative = path.relative(root, file);
  return relative !== "" && !relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative);
};

/**
 * 读取清单明确引用的资源，不遍历或复制整个开发目录。
 * 同时校验字面路径和 realpath，防止 ../、绝对路径或符号链接逃出项目目录。
 * 注意：这里先读取再检查大小；宿主安装时仍会独立检查产物，不能把构建器当成沙箱。
 * @param {string} root 项目根目录绝对路径。
 * @param {string} relative 相对于项目根目录的资源路径。
 * @param {number} maximum 允许读取的 UTF-8/二进制字节数上限。
 * @returns {Promise<{file: string, data: Buffer}>} 实际文件路径和资源内容。
 * @throws {Error} 路径越界、资源过大或文件不可读时失败，不生成占位资源。
 */
async function asset(root, relative, maximum) {
  if (typeof relative !== "string" || path.isAbsolute(relative)) throw new Error("Assets must use relative paths.");
  const file = path.resolve(root, relative);
  if (!within(root, file) || !within(await fs.realpath(root), await fs.realpath(file))) throw new Error("Asset escapes the plugin project.");
  const data = await fs.readFile(file);
  if (data.length > maximum) throw new Error("Asset exceeds its package limit.");
  return { file, data };
}

/**
 * 把一个开发项目打包为宿主可安装的 Jint 插件目录。
 *
 * 默认输出 project/dist/<manifest.id>；指定输出目录时，它不能是源码根目录或其祖先。
 * 建议始终使用专用 dist/artifacts 目录。本函数不会清空旧输出、执行 npm install，
 * 也不会替调用方部署/重载插件；重复构建仅更新本函数负责写出的文件。
 *
 * @param {string} project 包含 plugin.json 的开发项目目录，可使用相对路径。
 * @param {string} [destination] 可选发行目录，相对路径以进程工作目录为基准。
 * @returns {Promise<string>} 生成的安装包目录绝对路径。
 * @throws {Error} 清单/资源不合法、打包失败、存在外部 imports 或缺少声明导出时拒绝产出。
 */
export async function buildPlugin(project, destination) {
  // 1. 源清单可以指向 .ts/.js；安装包里的入口将在最后统一改为 server/plugin.mjs。
  const root = path.resolve(project);
  const manifest = JSON.parse((await asset(root, "plugin.json", 64 * 1024)).data.toString("utf8"));
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(manifest.id ?? "") || manifest.runtime !== "jint")
    throw new Error("A valid id and runtime=jint are required.");
  const output = path.resolve(destination ?? path.join(root, "dist", manifest.id));
  if (output === root || within(output, root)) throw new Error("Output cannot overwrite the source project or its ancestors.");
  const entry = await asset(root, manifest.entry, 2 * 1024 * 1024);
  // 2. neutral 不是 Node/browser polyfill。纯 JS 库可被打包，依赖平台全局的库仍需作者排查。
  // write:false 使导出/体积校验先于落盘；legalComments 保留依赖许可注释。
  const bundle = await build({
    entryPoints: [entry.file], bundle: true, write: false, format: "esm", platform: "neutral",
    target: "es2022", metafile: true, charset: "utf8", legalComments: "inline", mainFields: ["module", "main"], logLevel: "silent",
    plugins: [{
      name: "no-node-runtime",
      setup(builder) {
        // 显式拒绝 node: 内置模块，避免开发机可运行而 Jint 上线后才发现缺少运行时。
        builder.onResolve({ filter: /^node:/ }, args => ({ errors: [{ text: `Jint has no Node runtime: ${args.path}` }] }));
      }
    }]
  });
  const contents = bundle.outputFiles[0]?.contents;
  if (!contents || contents.length > 2 * 1024 * 1024) throw new Error("Bundle exceeds the 2 MiB host limit.");
  const outputs = Object.values(bundle.metafile.outputs);
  // 3. 禁止拆包及残留的外部 imports；生产宿主不会在运行时补装 npm 依赖。
  if (outputs.length !== 1 || outputs[0].imports.length) throw new Error("Runtime imports are not supported; produce one self-contained bundle.");
  const handlers = [
    ...Object.values(manifest.hooks ?? {}),
    ...(manifest.platforms ?? []).flatMap(p => Object.values(p.hooks ?? {})),
    ...(manifest.endpoints ?? []).map(e => e.handler),
    ...(manifest.tasks ?? []).map(t => t.handler),
    ...(manifest.jobs ?? []).map(j => j.handler),
    ...Object.values(manifest.streamMappers ?? {}).flatMap(m => [m.event, m.end, m.completion])
  ].filter(Boolean);
  // 静态校验“导出名称存在”；是否确实为函数由 Jint 加载时验证，构建器不会执行导出。
  for (const handler of handlers)
    if (!outputs[0].exports.includes(handler)) throw new Error(`Missing declared export: ${handler}`);
  const page = manifest.page?.entry ? await asset(root, manifest.page.entry, 1024 * 1024) : null;
  // 4. 只打包自包含 HTML。CSS、图片等应内联/开发期处理，不会自动复制 ui 目录下全部文件。
  const packaged = { ...manifest, schemaVersion: 1, hostApi: manifest.hostApi ?? "1", format: "esm-bundle", entry: "server/plugin.mjs" };
  if (page) packaged.page = { ...manifest.page, entry: "ui/index.html" };
  await fs.mkdir(path.join(output, "server"), { recursive: true });
  await fs.writeFile(path.join(output, "server", "plugin.mjs"), contents);
  if (page) {
    await fs.mkdir(path.join(output, "ui"), { recursive: true });
    await fs.writeFile(path.join(output, "ui", "index.html"), page.data);
  }
  await fs.writeFile(path.join(output, "plugin.json"), JSON.stringify(packaged, null, 2) + "\n");
  return output;
}

// 同时支持 CLI 和测试 import；被 import 时不启动构建，避免工具模块产生隐藏副作用。
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { console.log(await buildPlugin(process.argv[2] ?? ".", process.argv[3])); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
