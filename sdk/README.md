# JS 插件 SDK：人和 AI 的开发入口

生产运行在 Router2API 内的 Jint 4.16.4，不需要 Node。Host API 1 兼容 `1-preview`，不等同于 C# Contracts 2.0。

| 目标 | 文档 |
| --- | --- |
| 从零到发行包 | [JS 完整开发教程](js/DEVELOPMENT.md) |
| 查清单、权限、API | [API 手册](js/API.md)、[详细中文类型注释](js/index.d.ts) |
| 理解宿主执行 | [宿主运行流程](HOST-LIFECYCLE.md) |
| 交给 AI 实现 | [AI 开发工作单](AI-DEVELOPMENT.md) |
| 看实际业务源码 | [js-forwardapi](../plugins/js-forwardapi/src/plugin.ts)、[插件说明](../plugins/js-forwardapi/README.md) |
| 核对能力边界 | [C#/JS 能力对照](js/CAPABILITIES.md) |

从本仓库根目录执行：

```powershell
npm --prefix sdk/js ci
npm run check
npm test
npm run build
```

`check:docs` 检查本地链接、中文注释、类型/语法和禁止 C# 项目的边界。Node 测试只模拟 ctx，不声称真实 Jint/上游通过。本仓库不添加 .NET 项目，也不通过宿主源码运行测试。

后端只能使用类型导入和宿主注入的 ctx，不开放 Node/CLR/任意文件/进程能力。主案例只移植 ForwardAPI，不冒充其他提供方迁移或真实账号验收。
