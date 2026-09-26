# js-forwardapi

ForwardAPI 的 Jint JS/TS 实现，也是本仓库的[主开发教程](../../sdk/js/DEVELOPMENT.md)。模型前缀为 `js-forwardapi/`，不是 C# 版本的 `forwardapi/`。

## 已移植的功能

- NewAPI、Sub2API、Custom 账号配置和脱敏管理页面。
- 模型发现、候选刷新、明确的模型/端点允许表、账号权重。
- Chat Completions、Completions、Responses、Messages 原始 JSON/响应字节/SSE 转发。
- 401/403/429/5xx 等业务决策；宿主执行实际账号动作和尝试预算。
- NewAPI/Sub2API 额度、货币单位、订阅/速率窗口、精确十进制。
- 用户名/密码登录、临时 token/Cookie/UID、签到模板、备用路径、每日 Cron。
- 后台签到 job 的去重、进度、查询和取消。

只使用 SDK/ECMAScript，不包含 C#、.NET 项目、Node 运行时依赖或任意 CLR。

## 构建

从 JS 仓库根目录：

```powershell
npm --prefix sdk/js ci
npm run check
npm test
npm run test:build
npm run build:forwardapi
```

将 `plugins/js-forwardapi/dist/js-forwardapi` 完整复制到宿主运行目录的 `plugins/js-forwardapi`，再由管理员重载。不复制源码、node_modules 或账号数据。

## 添加账号

1. 打开 JS ForwardAPI 页面，填写站点、名称、API Key。
2. 新域名明确勾选 origin 授权，再获取模型。
3. 选择允许模型、端点和权重后保存；初始没有匿名账号。
4. 修改连接参数后重新发现，发现凭据仅保存 5 分钟；不能用伪造 availableModels 绕过。
5. 编辑密钥/密码留空保持原值；额外认证信息用可回填掩码，不回显实际秘密。

C# 版本的账号不会自动复制过来。请在独立命名空间重新录入，不通过跨插件查询共享凭据。

## 管理 API

所有端点都是当前插件相对路径，使用管理员会话/CSRF：

| 方法 | 路径 | 行为 |
| --- | --- | --- |
| GET | `accounts` | 脱敏卡片 |
| POST | `accounts/save`、`accounts/delete` | 保存/删除账号 |
| POST | `models/discover`、`models/refresh` | 发现/刷新候选，不自动扩大允许表 |
| POST | `quota/refresh` | 读取并 CAS 保存额度 |
| POST | `checkin/run` | 同步签到，受管理端点超时限制 |
| POST | `checkin/start` | 推荐：启动后台签到，只传 `{id}` |
| GET | `jobs/status?id=...` | 查询当前版本任务 |
| POST | `jobs/cancel` | 请求取消 `{id}` |
| GET | `origins` | 查看授权 |
| POST | `origins/revoke` | 撤销 `{origin}` |

Cron 是 `js-forwardapi-daily-checkin`，中国标准时间每天 10:10。Custom/Sub2API 未配签到路径就跳过；不自动执行无法确认成功的请求。

## 与 C# 版本的边界差异

- JS origin 必须由管理员明确批准，任务不能扩权；优先填写最终 HTTPS 地址。
- 模型 POST、管理和签到均直连；没有内层传输重试，返回流后不重发生成。
- 保存验证服务端发现缓存，不只信任页面回传模型列表。
- 更新凭据/额度/候选使用 CAS，冲突返回 409，不覆盖并发冷却。
- 金额输出为十进制字符串，避免 JS Number 精度损失。
- 缓冲上限 4 MiB，raw 流上限 32 MiB；大缓冲/非 JSON 响应不猜 usage。
- 普通管理请求约 25 秒，长签到使用最多 180 秒的独立 job。
- 需要当前宿主支持 `accounts.list({includeCredentials:true})`；默认账号列表仍不含秘密。

## 测试范围

`forwardapi.test.mjs` 在 Node 中进程内转译 TS，用内存状态/CAS、模拟 HTTP/source/job 和 BigInt 十进制参考实现验收业务，不启动子进程。`test:build` 另行校验真正的 esbuild 安装包。**不包含 C# 测试项目，不依赖宿主源码，不声称已经运行真实 Jint、浏览器或上游账号。**

真实宿主框架测试归宿主仓库；上线前仍需使用隔离测试宿主验证流取消、权限、账户规则及具体上游计费/签到行为。不要把 HTTP 200、Node 测试通过或一次成功打包当成真实上游验收。
