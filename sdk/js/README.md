# Jint JS 插件

当前支持 **Host API 1**，兼容 `1-preview`；生产使用 Jint 4.16.4，不需要 Node。

- [SDK 总入口：人和 AI 的阅读顺序](../README.md)
- [JS/TS 开发全过程：从脚手架到发布回滚](DEVELOPMENT.md)
- [宿主运转流程：加载、选号、Polly、SSE、任务与卸载](../HOST-LIFECYCLE.md)
- [AI 开发工作单与验收规范](../AI-DEVELOPMENT.md)
- [完整 API、清单、权限及迁移说明](API.md)
- [C#/JS 能力逐项对照](CAPABILITIES.md)
- [带详细中文注释的 TypeScript 类型定义](index.d.ts)
- [主案例 js-forwardapi](../../plugins/js-forwardapi/README.md)
- [可安装示例：Echo、代理池、Cron、后台 job](../../plugins/js-proxy-demo/)
- C# 宿主能力说明（参见 `Rouer-Plugins-Csharp/sdk/csharp/README.md`）

开发工具：

```powershell
npm --prefix sdk/js ci
node sdk/js/init.mjs ./my-plugin
node sdk/js/build.mjs ./my-plugin
```

完整开发应在生成项目中先安装开发依赖、`npm run check`，再构建，步骤见开发教程。只想检查 SDK 文档和自带教程：

```powershell
npm run check
npm test
npm run build
```

`check:docs` 不启动子进程/宿主、不执行插件；检查本地链接目标、中文类型注释、教学源码/清单类型和页面脚本语法。真正构建与运行时回归另见教程，不把静态通过等同于线上验证。

主教程使用 js-forwardapi，Echo 仅保留作工具链 smoke test。JS 仓库只允许 JS/TS 和 Node 模拟测试，不添加 C# 源码/项目；模拟测试不能替代实际 Jint 和上游验收。
