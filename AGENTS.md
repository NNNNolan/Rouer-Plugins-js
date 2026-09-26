# 仓库开发约定

- 本地 shell 默认 PowerShell 7。
- 本仓库只能包含 JS/TS 插件及 Node 模拟测试，不得加入 C#、csproj、sln 或依赖宿主源码的测试项目。
- 测试入口是根目录 npm test；编译/文档检查使用 npm run check，主教程为 plugins/js-forwardapi。
- 先阅读 README.md、sdk/README.md 和 sdk/AI-DEVELOPMENT.md。
- 这是独立公开源码仓库，不依赖或导入私有开发仓库、真实配置、凭据、日志、数据库及 Git 历史。
- 构建、测试、安装和推送是不同操作；未经明确授权不安装到生产、不提交或推送。
- 保留 Contracts/Host API 和 SSE 生命周期边界，按 README 执行对应仓库测试。
