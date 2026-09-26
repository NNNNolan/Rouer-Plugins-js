/**
 * @file SDK 开发工具的集成检查。
 * 只在专用临时目录创建/打包测试项目，不安装插件、不访问计费上游。
 * 构建测试不执行用户 hook；教学样例测试只用 mock ctx 在 Node 中运行已知的教程源码，
 * 验证输入、进度和取消，不冒充真实 Jint/浏览器集成测试。
 * node:test 和 esbuild 需要启动子进程；若执行环境禁止 spawn，应报告“未运行”，不能吞错。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildPlugin } from "./build.mjs";
import { initPlugin } from "./init.mjs";

test("TypeScript scaffold builds a bounded single ESM package without executing hooks", async () => {
  // 独占临时目录便于验证输出与源码隔离；finally 中再检查边界后清理。
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "router2api-sdk-"));
  try {
    const project = await initPlugin(path.join(base, "demo"));
    // 不只检查单文件转换：增加纯 TS 模块，验证 bundle 内实际含有被引用的模块内容。
    await fs.writeFile(path.join(project, "src", "message.ts"), 'export const message: string = "bundled-helper";');
    const source = await fs.readFile(path.join(project, "src", "plugin.ts"), "utf8");
    await fs.writeFile(path.join(project, "src", "plugin.ts"),
      'import { message } from "./message";\n' + source.replace('"Hello from Jint"', "message"));
    const output = await buildPlugin(project);
    const manifest = JSON.parse(await fs.readFile(path.join(output, "plugin.json"), "utf8"));
    assert.equal(manifest.entry, "server/plugin.mjs");
    assert.equal(manifest.hostApi, "1");
    assert.match(await fs.readFile(path.join(output, manifest.entry), "utf8"), /function invoke/);
    assert.match(await fs.readFile(path.join(output, manifest.entry), "utf8"), /bundled-helper/);
    const sample = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../plugins/js-proxy-demo");
    // 同时验证仓库示例的 job 声明与自包含页面会进入发行包。
    const sampleOutput = await buildPlugin(sample, path.join(base, "built-sample"));
    const sampleManifest = JSON.parse(await fs.readFile(path.join(sampleOutput, "plugin.json"), "utf8"));
    assert.equal(sampleManifest.jobs[0].name, "js-proxy-demo-probe");
    assert.match(await fs.readFile(path.join(sampleOutput, "ui", "index.html"), "utf8"), /后台任务/);
    // 真实提供方也必须通过单 ESM 清单/导出检查，Node 业务模拟不替代发行包验证。
    const forward = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../plugins/js-forwardapi");
    const forwardOutput = await buildPlugin(forward, path.join(base, "js-forwardapi"));
    const forwardManifest = JSON.parse(await fs.readFile(path.join(forwardOutput, "plugin.json"), "utf8"));
    assert.equal(forwardManifest.id, "js-forwardapi");
    assert.equal(forwardManifest.entry, "server/plugin.mjs");
    assert.equal(forwardManifest.jobs[0].name, "js-forwardapi-checkin");
    await assert.rejects(initPlugin(project), /exist/i);
    await assert.rejects(buildPlugin(project, project), /overwrite/);
    await fs.writeFile(path.join(project, "src", "plugin.ts"), 'import fs from "node:fs"; export function invoke(){return fs.readFileSync("secret");}');
    // 这是预期失败用例：拒绝 Node 内置模块不应被报告为 Jint 已支持 fs。
    await assert.rejects(buildPlugin(project), /Node runtime|Build failed/);
  } finally {
    // 递归删除前核对绝对路径和专用前缀，不把未经核对的计算路径交给另一个 shell。
    const target = path.resolve(base);
    const boundary = path.resolve(os.tmpdir()) + path.sep;
    if (!target.startsWith(boundary) || !path.basename(target).startsWith("router2api-sdk-"))
      throw new Error("Unsafe test cleanup path.");
    await fs.rm(target, { recursive: true, force: true });
  }
});

test("Tutorial package documents working Echo, job validation, progress and cancellation with mock host capabilities", async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "router2api-sdk-"));
  try {
    const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../plugins/tutorial-echo");
    const output = await buildPlugin(project, path.join(base, "tutorial-echo"));
    const manifest = JSON.parse(await fs.readFile(path.join(output, "plugin.json"), "utf8"));
    assert.equal(manifest.page.entry, "ui/index.html");
    assert.equal(manifest.jobs[0].handler, "demoProgress");
    // 只执行仓库自带的无网络教学代码；外部插件始终不由构建器 import。
    const plugin = await import(pathToFileURL(path.join(output, manifest.entry)).href);
    const json = (statusCode, body) => ({ statusCode, body });
    const reply = { completion: completion => ({ completion }), error: json };
    assert.equal(plugin.getModels()[0].id, "echo");
    const request = { model: "echo", tools: [], messages: [{ role: "user", content: "你好" }] };
    assert.equal(plugin.invoke({ request, reply }).completion.content, "Jint Echo: 你好");
    assert.equal(plugin.invoke({ request: { ...request, model: "unknown" }, reply }).statusCode, 404);
    assert.equal(plugin.invoke({ request: { ...request, tools: [{}] }, reply }).statusCode, 400);

    const local = new Map();
    let anonymousCalls = 0;
    const startContext = {
      accounts: { ensureAnonymous: async () => { anonymousCalls++; } },
      state: { local: { set: async (key, value) => { local.set(key, value); } } }
    };
    await plugin.start(startContext);
    assert.equal(anonymousCalls, 1);
    assert.ok(Number.isFinite(Date.parse(local.get("started-at"))));

    // 后端独立验证，不因 HTML 上有 min/max 就相信字符串、越界数或错误形状。
    for (const body of [null, {}, [], { steps: "3" }, { steps: 0 }, { steps: 21 }, { steps: 1.5 }])
      assert.equal((await plugin.startJob({ body, json })).statusCode, 400);
    const queued = await plugin.startJob({
      body: { steps: 3 }, json,
      jobs: { start: async (name, input, options) => {
        assert.equal(name, "demo-progress");
        assert.deepEqual(input, { steps: 3 });
        assert.equal(options.key, "tutorial-progress");
        return { id: "job-1", state: "Queued" };
      } }
    });
    assert.equal(queued.statusCode, 202);
    assert.equal(queued.body.state, "Queued");
    const progress = [], waits = [];
    const result = await plugin.demoProgress({
      jobs: { progress: async value => { progress.push(value); } },
      delay: async milliseconds => { waits.push(milliseconds); }
    }, { steps: 3 });
    assert.equal(result.demo, true);
    assert.deepEqual(progress.map(value => value.completed), [0, 1, 2, 3]);
    assert.deepEqual(waits, [250, 250, 250]);
    await assert.rejects(plugin.demoProgress({}, { steps: -1 }), /1–20/);
    await assert.rejects(plugin.demoProgress({
      jobs: { progress: async () => {} },
      delay: async () => { throw new Error("host.cancelled"); }
    }, { steps: 2 }), /host.cancelled/);
    assert.equal((await plugin.getJob({ query: {}, json })).statusCode, 400);
    assert.equal((await plugin.getJob({ query: { id: "missing" }, json, jobs: { get: async () => null } })).statusCode, 404);
    assert.equal((await plugin.cancelJob({ body: {}, json })).statusCode, 400);
    assert.deepEqual((await plugin.cancelJob({
      body: { id: "job-1" }, json, jobs: { cancel: async id => id === "job-1" }
    })).body, { accepted: true });
  } finally {
    // 只删除本测试创建的临时目录；先校验绝对边界，再使用同一 Node 进程完成清理。
    const target = path.resolve(base);
    const boundary = path.resolve(os.tmpdir()) + path.sep;
    if (!target.startsWith(boundary) || !path.basename(target).startsWith("router2api-sdk-"))
      throw new Error("Unsafe test cleanup path.");
    await fs.rm(target, { recursive: true, force: true });
  }
});
