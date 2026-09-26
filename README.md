# Rouer-Plugins-js

Router2API 的 Jint JavaScript/TypeScript 插件仓库。生产插件运行在宿主内的 **Jint 4.16.4**，Node 只用于开发、类型检查和打包。

本仓库只包含 JS/TS 插件、SDK、页面与 **Node 模拟测试**，禁止 C#、csproj、sln 和依赖宿主源码的测试项目。可独立检查/打包；运行插件需要另行安装 Router2API。

## 当前内容

| 目录 | 内容 |
| --- | --- |
| `plugins/js-forwardapi` | 主案例：ForwardAPI 账号、模型/端点允许表、原始转发/SSE、额度、签到和页面 |
| `sdk/js` | Host API 1 中文类型定义、脚手架/构建器 |
| `plugins/tutorial-echo` | SDK 工具链的无网络 smoke test，不是主开发教程 |
| `plugins/js-proxy-demo` | Echo + 独立代理池 HTTP 示例 |
| `sdk` | 人/AI 共用的开发教程和宿主生命周期说明 |

`js-forwardapi` 移植自公开 C# ForwardAPI，管理权限、CAS、缓冲配额等差异见[插件说明](plugins/js-forwardapi/README.md)。这不表示其他未公开提供方已经迁移，也不表示真实账号已验收。

## 开发与构建

```powershell
npm --prefix sdk/js ci
npm run check
npm test
npm run test:build
npm run build

# 也可单独打包：
npm run build:forwardapi
npm run build:proxy-demo
npm run build:tutorial-echo
```

`npm run build` 打包全部三个插件，产物目录为：

```text
plugins/js-forwardapi/dist/js-forwardapi/
plugins/js-proxy-demo/dist/js-proxy-demo/
plugins/tutorial-echo/dist/tutorial-echo/
```

每个发行包包含清单、单个 ESM 和 HTML；只复制完整包到宿主对应的 `plugins/<id>`。生产不用 npm，不复制 TS、node_modules、配置、测试或凭据。
`test:build` 仅在临时目录验证打包并在结束后清理，不会生成上述发行目录。打包不执行插件；`tutorial-echo` 无网络，`js-proxy-demo` 安装后的手动检查和每日 Cron 会访问 `example.com`。

新建自己的项目：

```powershell
node sdk/js/init.mjs ./my-plugin
Push-Location ./my-plugin
npm install
npm run check
npm run build
Pop-Location
```

SDK 当前是仓库内 `file:` 依赖，不假定已发布到公共 npm。后端用 `import type` 和宿主提供的 `ctx`，不能导入 Node、CLR、DOM 或 `fetch`。

## 教程

- [以 js-forwardapi 为例的完整开发流程](sdk/js/DEVELOPMENT.md)
- [API 与权限](sdk/js/API.md)
- [中文类型注释](sdk/js/index.d.ts)
- [宿主运行流程](sdk/HOST-LIFECYCLE.md)
- [AI 开发工作单](sdk/AI-DEVELOPMENT.md)
- [能力对照与测试边界](sdk/js/CAPABILITIES.md)

跨仓库说明只提供背景阅读位置，不是测试依赖。`npm test` 使用进程内 TypeScript 转译和 Node mock ctx，不启动子进程或运行 .NET/Jint/SQLite；`test:build` 单独检查 esbuild 产物，需要允许开发工具子进程。宿主负责自己的框架测试，JS 仓库不添加 C# 项目。

## 发布注意

仅安装管理员审阅的脚本；不提交真实密钥、账号、日志、数据库、开发产物或私有仓库历史。教学测试只覆盖已声明范围，不代替真实 Jint/浏览器/计费验收。项目尚未指定新的主许可证，公开前由维护者确认。
