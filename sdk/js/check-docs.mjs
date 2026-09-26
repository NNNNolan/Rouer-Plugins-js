#!/usr/bin/env node
/**
 * @file SDK 文档的离线静态检查，不启动子进程、宿主或真实上游，不执行用户插件。
 * 使用已有 TypeScript 和 Node 标准库，检查本地链接目标、中文类型注释、教学源码/
 * 清单的类型、导出匹配及页面脚本语法。它不能替代 esbuild、Jint 或提供方验收。
 *
 * @example npm --prefix sdk/js run check:docs
 */
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";
import ts from "typescript";

const directory = path.dirname(fileURLToPath(import.meta.url));
const sdkDirectory = path.resolve(directory, "..");
const repository = path.resolve(directory, "../..");
const projects = [
  path.join(repository, "plugins", "js-forwardapi"),
  path.join(repository, "plugins", "tutorial-echo")
];
const declarationPath = path.join(directory, "index.d.ts");
const failures = [];

/** 遍历本仓库文档，同时确保 JS 仓库不引入 C#/.NET 项目；跳过依赖和构建产物。 */
async function markdownFiles(root) {
  const files = [];
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory() && !entry.name.startsWith(".") && !["node_modules", "dist", "bin", "obj", "artifacts", "wwwroot"].includes(entry.name))
      files.push(...await markdownFiles(file));
    else if (entry.isFile()) {
      if (/\.(cs|csproj|sln|slnx|fsproj|vbproj)$/i.test(entry.name) || /^Directory\.Build\.(props|targets)$/i.test(entry.name))
        failures.push(`JS 仓库禁止加入 C#/.NET 项目：${path.relative(repository, file)}`);
      if (entry.name.endsWith(".md")) files.push(file);
    }
  }
  return files;
}

/**
 * 校验本文档集使用的行内 Markdown 相对链接，避免重命名后教程仍指向不存在的文件。
 * 不访问外网、不解析完整 Markdown，也不声称验证网页内容或片段锚点。
 */
async function checkLinks(files) {
  let count = 0;
  for (const file of files) {
    const text = await fs.readFile(file, "utf8");
    for (const match of text.matchAll(/\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
      const href = match[1].replace(/^<|>$/g, "");
      if (/^[a-z][\w+.-]*:/i.test(href)) continue;
      const relative = href.split(/[?#]/, 1)[0];
      if (!relative) continue;
      count++;
      try { await fs.access(path.resolve(path.dirname(file), decodeURIComponent(relative))); }
      catch { failures.push(`${path.relative(sdkDirectory, file)}：本地链接不存在 ${href}`); }
    }
  }
  return count;
}

/** 导出类型及全部具名属性/方法必须有中文 JSDoc，嵌套选项和方法重载也要说明。 */
function checkChineseComments(source) {
  let count = 0;
  function visit(node) {
    const exported = (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node))
      && node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword);
    if (exported || ts.isPropertySignature(node) || ts.isMethodSignature(node)) {
      count++;
      if (!ts.getJSDocCommentsAndTags(node).some(doc => /\p{Script=Han}/u.test(doc.getText(source)))) {
        const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
        failures.push(`index.d.ts:${line}：${node.name?.getText(source) ?? "类型"} 缺少中文 JSDoc`);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return count;
}

const files = await markdownFiles(repository);
const linkCount = await checkLinks(files);
const examples = await Promise.all(projects.map(async (root, index) => {
  const manifestText = await fs.readFile(path.join(root, "plugin.json"), "utf8");
  return {
    root, manifest: JSON.parse(manifestText), entry: path.join(root, "src", "plugin.ts"),
    virtualPath: path.join(directory, `.manifest-${index}.check.ts`),
    virtualSource: `import type { PluginManifest } from "./index";\nconst manifest: PluginManifest = ${manifestText};\nexport default manifest;`
  };
}));
// 在内存中检查清单，不生成 C# 测试、临时项目或需要宿主源码的构建步骤。
const virtualSources = new Map(examples.map(example => [example.virtualPath, example.virtualSource]));
const options = {
  noEmit: true, strict: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler, lib: ["lib.es2022.d.ts"], types: []
};
const host = ts.createCompilerHost(options);
const originalGetSourceFile = host.getSourceFile.bind(host);
host.getSourceFile = (file, languageVersion, onError, shouldCreateNewSourceFile) => {
  const value = virtualSources.get(path.resolve(file));
  return value === undefined ? originalGetSourceFile(file, languageVersion, onError, shouldCreateNewSourceFile)
    : ts.createSourceFile(file, value, languageVersion, true);
};
const program = ts.createProgram([declarationPath, ...examples.flatMap(example => [example.entry, example.virtualPath])], options, host);
const diagnostics = ts.getPreEmitDiagnostics(program);
if (diagnostics.length)
  failures.push(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCanonicalFileName: file => file, getCurrentDirectory: () => directory, getNewLine: () => "\n"
  }));
const declaration = program.getSourceFile(declarationPath);
assert.ok(declaration, "找不到 SDK 类型定义");
const commentCount = checkChineseComments(declaration);

// 清单 handler 不只是任意字符串：至少在教学入口中确有对应命名导出。
// 是否为宿主认可的函数/签名、权限与阶段是否正确，仍由真实 Jint 加载和测试验证。
for (const item of examples) {
  const manifest = item.manifest;
  const example = program.getSourceFile(item.entry);
  assert.ok(example, "找不到教程 TypeScript 入口");
  const checker = program.getTypeChecker();
  const moduleSymbol = checker.getSymbolAtLocation(example);
  assert.ok(moduleSymbol, "教程必须是 ES 模块");
  const exportNames = new Set(checker.getExportsOfModule(moduleSymbol).map(symbol => symbol.name));
  const handlers = [
    ...Object.values(manifest.hooks ?? {}),
    ...Object.values(manifest.platform?.hooks ?? {}),
    ...(manifest.platforms ?? []).flatMap(platform => Object.values(platform.hooks ?? {})),
    ...(manifest.endpoints ?? []).map(endpoint => endpoint.handler),
    ...(manifest.tasks ?? []).map(task => task.handler),
    ...(manifest.jobs ?? []).map(job => job.handler),
    ...Object.values(manifest.streamMappers ?? {}).flatMap(mapper => [mapper.event, mapper.end, mapper.completion])
  ].filter(Boolean);
  for (const handler of handlers)
    if (!exportNames.has(handler)) failures.push(`教程清单缺少实际导出：${handler}`);
  assert.equal(manifest.entry, "src/plugin.ts", "教程源清单应引用被检查的 TS 入口");

  // Script 只做语法编译，不运行 DOM/浏览器代码；不代表做过浏览器交互测试。
  const page = await fs.readFile(path.join(item.root, manifest.page.entry), "utf8");
  const scripts = [...page.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)];
  assert.ok(scripts.length, "教程页面应包含演示宿主桥的脚本");
  for (const [index, script] of scripts.entries())
    new Script(script[1], { filename: `${manifest.id}/ui/index.html#script-${index + 1}` });
}

if (failures.length) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`SDK 文档检查通过：${files.length} 篇 Markdown、${linkCount} 个本地链接目标、${commentCount} 项中文类型注释。`);
  console.log("教程源码/清单严格类型检查、命名导出和页面脚本语法检查通过；未运行插件或真实上游。");
  console.log("JS 仓库语言边界检查通过：没有 C# 源码或 .NET 项目。");
}
