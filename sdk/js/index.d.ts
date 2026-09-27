/**
 * Router2API Jint 插件 Host API 1 的开发期类型定义，兼容已有 1-preview 清单。
 *
 * 本文件不是运行时 SDK：只用 `import type` 引入类型，ctx 由 C# 宿主注入。
 * 生产运行在 Jint 4.16.4 中，不提供 Node、DOM、fetch、任意 CLR 或文件系统对象。
 * 所有权限、资源身份、配额和取消均由宿主复核；修改 ctx 上的标识不会改变实际归属。
 *
 * 阅读顺序：DEVELOPMENT.md → ../HOST-LIFECYCLE.md → API.md → 本文件。
 */
/** 可跨宿主桥接的 JSON 值；金额/Int64 建议用字符串，不能传函数、BigInt、Map/Set 或循环引用。 */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/**
 * 与 C# PluginAttemptDecision 同义的单次业务决策，不会立即执行资源动作。
 * 宿主校验并执行一次；不要先调用 accounts.setCooldown，再返回同一个冷却动作。
 * 对成功响应不执行惩罚，已返回的流不启动下一次生成请求。
 */
export interface AttemptDecision {
  /** 失败分类，默认 None；Transport 必须有原生 HTTP 证据才保留传输故障分类。 */
  failureKind?: "None" | "Upstream" | "InvalidCredential" | "Transport" | "Plugin";
  /** 默认 None；NextAttempt 仅申请下一次业务尝试，仍受次数/总时限约束，不开启内层 HTTP 重试。 */
  retry?: "None" | "NextAttempt";
  /** 只作用于宿主本次选中的账号，默认 None；不能在这里指定另一个账号。 */
  accountAction?: "None" | "Cooldown" | "Disable";
  /** 带时区的 ISO 8601 截止时间；Cooldown 时必填，其他动作不得设置，最多未来 30 天。 */
  accountCooldownUntil?: string;
  /** 可选的持久化账号原因；缺省时宿主用尝试 reason/reasonCode，不把它当判定表达式解析。 */
  accountReason?: string;
  /** 默认 None；Cooldown 还需当前 attempt 路由确有代理传输异常/407，脚本声明不能伪造证据。 */
  proxyAction?: "None" | "Cooldown";
  /** 稳定诊断代码，默认 none，1–128 字符且不得含控制字符；宿主不解析文本决定重试。 */
  reasonCode?: string;
}

/** 模型入口结果中的 attempt 字段；新插件用 decision，outcome 仅用于预览版兼容。 */
export type AttemptResult = {
  /** 显式决策，是新接口的动作依据。 */
  decision: AttemptDecision;
  /** 上游状态码；未收到 HTTP 响应时可省略，不要编造一个代理 407。 */
  statusCode?: number;
  /** 面向操作者的错误说明；不得拼入 token、密码或完整 Authorization。 */
  reason?: string;
} | {
  /** 旧 1-preview 分类，会先转换为显式决策；新插件不应再组合多套布尔标志。 */
  outcome: "Healthy" | "Retry" | "CooldownNode" | "CooldownAccount" | "DisableAccount" | "NoPenalty";
  /** 旧格式的上游状态码，可省略。 */
  statusCode?: number;
  /** 旧格式的诊断说明，不是宿主执行的脚本或规则。 */
  reason?: string;
};

/** getModels 导出的模型描述；宿主对外加平台前缀，插件不要重复添加。 */
export interface ModelDescriptor {
  /** 上游/平台内部模型 ID，非空、最多 256 字符，例如 echo 或 cn/model-name。 */
  id: string;
  /** 管理页显示名；不是用于路由的唯一标识。 */
  displayName: string;
  /** 上下文窗口 token 数；缺省为 0，表示未声明，不代表无限。 */
  contextWindow?: number;
  /** 是否支持流式；宿主模型描述默认 true，仍需实际实现 completion 转流或 mapper。 */
  supportsStreaming?: boolean;
  /** 输入 token 上限，缺省为 0（未声明）。 */
  inputLimit?: number;
  /** 输出 token 上限，缺省为 0（未声明）。 */
  outputLimit?: number;
  /** 是否支持推理，缺省 false；不能据此擅自修改用户的推理档位。 */
  supportsReasoning?: boolean;
  /** 提供方支持的推理档位；未知时省略/null，不要虚构通用枚举。 */
  reasoningLevels?: string[] | null;
  /** 可选的推理 token 上限。 */
  reasoningTokenLimit?: number | null;
  /** 可选积分倍率说明，用字符串保存，避免金额/倍率的浮点误差。 */
  creditMultiplier?: string | null;
}

/**
 * HTTP 请求规格。body/bodyText/bodyBase64/form/originalJson 五者最多设置一个。
 * 请求缓冲上限 4 MiB；URL origin 与 route 必须都获得清单或管理员授权。
 */
export interface HttpRequest {
  /** HTTP 方法，默认 GET；不安全方法的重放须额外显式授权。 */
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";
  /** 完整 HTTP(S) URL；禁止 userinfo、fragment，不能用未授权 URL 重定向绕过检查。 */
  url: string;
  /** 默认 pool；attempt 沿用当前模型尝试的路由，不能在控制面/任务中伪造。 */
  route?: "pool" | "direct" | "attempt";
  /** 本次调用内的固定客户端句柄；优先使用 createClient 返回对象的方法，不要手工拼句柄。 */
  client?: string;
  /** 明确发送的头；禁止 Host/Connection/Content-Length/Transfer-Encoding/Proxy-Authorization/Upgrade 等。 */
  headers?: Record<string, string>;
  /** JSON 正文，默认 application/json；此数据已经过 JS Number，精确原始字段请用 originalJson。 */
  body?: Json;
  /** UTF-8 文本正文，默认 text/plain；不是二进制容器。 */
  bodyText?: string;
  /** 二进制正文的 Base64 字符串，默认 application/octet-stream；不是 data URL。 */
  bodyBase64?: string;
  /** application/x-www-form-urlencoded 字段，宿主负责百分号编码。 */
  form?: Record<string, string>;
  /** 可选请求正文 Content-Type；没有正文时不要设置正文头。 */
  contentType?: string;
  /** 原生顶层 JSON 编辑，保留未修改的大整数/未知字段；只有 Terminal 的原请求句柄可用。 */
  originalJson?: {
    /** 必须是当前 ctx.request.originalBodyRef，不能从上次请求/状态缓存复用。 */
    source: string;
    /** 要移除的顶层属性名，不是 JSON Pointer；remove 与 set 合计最多 128 项。 */
    remove?: string[];
    /** 要设置的顶层字段；仅这些新值经过 JS 序列化，其余原值由宿主保留。 */
    set?: Record<string, Json>;
  };
  /** 缓冲响应解码方式，默认 json；上游可能返回非 JSON 错误时可选 text 自行解析。 */
  responseType?: "json" | "text" | "base64";
  /** 1–60000 毫秒，默认 30000；request 覆盖发送/重试/读取，open 只约束返回 source 前的阶段。 */
  timeoutMs?: number;
  /** source 两次原始字节读取之间的空闲上限，100–600000 毫秒；缺省使用宿主 ReadIdleTimeout。 */
  readIdleTimeoutMs?: number;
  /** pool 允许选用的订阅 ID；省略/空数组表示所有启用订阅，不是指定某个节点。 */
  subscriptionIds?: string[];
  /** 默认 false；pool 无节点时允许直连还需清单中有 direct 权限，不会自动开启。 */
  allowDirectFallback?: boolean;
  /**
   * 默认 false；开启后最多 5 次跳转，每跳重验 origin。
   * 跨 origin 只允许跳转后的 GET/HEAD，只保留 Accept/Accept-Language/User-Agent；
   * 当前按方法而非“正文是否存在”判断，不要对带正文的 GET/HEAD 使用跨 origin 跳转。
   */
  followRedirects?: boolean;
  /** 仅独立 pool 发送可用，固定 client/attempt/direct 不接受额外传输重试；不处理业务状态码。 */
  retry?: {
    /** 额外次数 0–5；默认无重试。模型 policy.maxAttempts > 1 时不能再叠加。 */
    maxRetries: number;
    /** 重试间隔 0–30000 毫秒，默认 200；父调用取消会终止等待。 */
    delayMs?: number;
    /** 默认 false，仅 GET/HEAD/OPTIONS 可自动重放；true 表示调用方承担重复计费/副作用风险。 */
    allowUnsafeMethods?: boolean;
  };
}

/** request 的 JSON/文本缓冲响应；HTTP 非 2xx 本身不会由工厂抛错或触发换号。 */
export interface HttpResult {
  /** 上游实际 HTTP 状态码。 */
  statusCode: number;
  /** 普通头与正文头的合并视图，键转为小写、值为数组；Cookie 需调用方明确处理。 */
  headers: Record<string, string[]>;
  /** json 时为解析后的 JSON，text 时为字符串；JSON 解析失败会拒绝本次调用。 */
  body: Json;
  /** 解码后的 UTF-8 正文；不是保持任意二进制的字段。 */
  bodyText: string;
}

/** responseType=base64 的缓冲结果，不包含 body/bodyText。 */
export interface HttpBinaryResult {
  /** 上游实际 HTTP 状态码。 */
  statusCode: number;
  /** 小写头名及多个头值，不会自动保存 Cookie。 */
  headers: Record<string, string[]>;
  /** 未经文本解码的响应字节编码，可用 raw bodyBase64 回传。 */
  bodyBase64: string;
}

/** 调用内的固定 HTTP 客户端。pool 只选一次代理，多次发送共用该绑定，不共用 Cookie 容器。 */
export interface HttpClientHandle {
  /** 不可伪造的宿主句柄；不能跨 Engine、存入 state 或交给另一个 job。 */
  handle: string;
  /** 使用固定客户端读取二进制缓冲结果；不能再传 retry 或修改 route。 */
  request(spec: HttpRequest & {
    /** 选择二进制返回形状，仅含 bodyBase64，不含 body/bodyText。 */
    responseType: "base64";
  }): Promise<HttpBinaryResult>;
  /** 使用固定客户端读取 JSON/文本；响应读取完成后自动释放本次请求/响应。 */
  request(spec: HttpRequest & {
    /** 缺省 json；text 不尝试 JSON.parse，便于处理上游非 JSON 错误。 */
    responseType?: "json" | "text";
  }): Promise<HttpResult>;
  /** responseType 在运行时才确定的重载，调用方须先区分联合返回类型。 */
  request(spec: HttpRequest): Promise<HttpResult | HttpBinaryResult>;
  /** 返回当前调用内的 source；必须消费、关闭或移交给最终流响应。 */
  open(spec: HttpRequest): Promise<HttpSource>;
  /** 提前释放客户端；不要在仍需读取其 source 时调用。整个 invocation 结束也会兜底释放。 */
  close(): Promise<void>;
}

/** 无 CLR 对象的 HTTP 能力；资源所有权在宿主，脚本只能操作规格和本次句柄。 */
export interface HttpApi {
  /** 发送并完整缓冲二进制响应；需要目的 origin 和 route 的许可。 */
  request(spec: HttpRequest & {
    /** 显式选择 Base64 字节结果，避免二进制经过 UTF-8 解码失真。 */
    responseType: "base64";
  }): Promise<HttpBinaryResult>;
  /** 发送并缓冲 JSON/文本，默认 GET/pool/json；响应所有权在完成本次 Promise 时由宿主回收。 */
  request(spec: HttpRequest & {
    /** 缺省解析 JSON；text 同时返回文本 body 与 bodyText。 */
    responseType?: "json" | "text";
  }): Promise<HttpResult>;
  /** 动态 responseType 重载，返回值需做类型分支。 */
  request(spec: HttpRequest): Promise<HttpResult | HttpBinaryResult>;
  /** 只等到响应头并返回 source；收到句柄不等于响应体读完，不允许跨调用保存句柄。 */
  open(spec: HttpRequest): Promise<HttpSource>;
  /**
   * 为一组请求创建固定客户端，最多同时 4 个；无需账号的任务也可使用。
   * @param options 路由默认 pool；不支持 attempt，因为模型尝试已经拥有绑定客户端。
   * @returns 本次调用内的客户端对象，使用 finally/close 提前回收。
   */
  createClient(options?: {
    /** pool 选一次代理；direct 明确直连。 */
    route?: "pool" | "direct";
    /** pool 的启用订阅范围，空表示不额外限制。 */
    subscriptionIds?: string[];
    /** 默认 false；启用直连回退还需 direct 权限。 */
    allowDirectFallback?: boolean;
  }): Promise<HttpClientHandle>;
  /** 将 source 作为 UTF-8 文本缓冲（最多 4 MiB）并关闭；失败时也回收资源。 */
  readText(handle: string): Promise<string>;
  /** 将 source 缓冲并解析为 JSON、随后关闭；空正文返回 null，非法 JSON 抛错。 */
  readJson(handle: string): Promise<Json>;
  /** 将 source 缓冲为 Base64 后关闭，适合不经文本转换的二进制内容。 */
  readBase64(handle: string): Promise<string>;
  /** 消耗/丢弃 source 正文并关闭，不积累整个字符串；累计最多 32 MiB，仍遵守取消与空闲超时。 */
  drain(handle: string): Promise<{
    /** 已读取的原始字节总数，不是字符数。 */
    bytesRead: number;
  }>;
  /** 仅限 HTTP >=400 的 source；缓冲最多 4 MiB，返回截断摘要但保留 source 供 raw 回传。 */
  snapshotError(handle: string): Promise<{
    /** 最多 4000 个字符的错误正文；可能含敏感信息，日志前须处理。 */
    text: string;
    /** 是否因摘要长度限制而截断；超出缓冲限制则整体失败，不会返回部分成功。 */
    truncated: boolean;
  }>;
  /** 不再需要 source 时关闭；已经消费/关闭的句柄不能再次读取。 */
  close(handle: string): Promise<void>;
  /** 读取本插件额外批准的 origin，需 http.manageOrigins；不包含清单静态 origins。 */
  approvedOrigins(): Promise<string[]>;
  /** 仅管理员管理端点可持久化批准精确 origin，需 http.manageOrigins；模型/任务/刷新回调不可授权。 */
  approveOrigin(origin: string): Promise<void>;
  /** 管理端点撤销本插件的额外授权，权限与 approveOrigin 相同；清单静态许可不受影响。 */
  revokeOrigin(origin: string): Promise<void>;
}

/** 上游响应的元数据及不透明句柄，不是 fetch Response，也不是 CLR Stream。 */
export interface HttpSource {
  /** 当前 invocation 的唯一 source 标识，最多同时 4 个；读完/关闭/移交后不要复用。 */
  handle: string;
  /** 上游实际状态；调用 reply.raw 前应自行解释非 2xx 业务错误。 */
  statusCode: number;
  /** 合并后的小写响应头，多个值用数组表示。 */
  headers: Record<string, string[]>;
  /** 上游 Content-Type；未提供时为 application/octet-stream。 */
  contentType: string;
}

/** 宿主解析完一个 SSE 帧后交给同步 event mapper 的输入；不含底层字节流。 */
export interface SseFrame {
  /** 拼接后的 data 行（多行以换行连接）；[DONE] 等结束标记仍须提供方 mapper 判断。 */
  data: string;
  /** 可选 event 字段，不是 HTTP 事件监听器。 */
  event?: string | null;
  /** 可选 SSE id；不要将其当账号或宿主 source 标识。 */
  id?: string | null;
  /** 上游 SSE retry 数值；不代表宿主会重新发送模型请求。 */
  retry?: number | null;
}

/** 协议无关的输出增量，宿主写出器再转为 Chat/Responses/Messages；不要在这里拼 SSE 行。 */
export interface StreamChunk {
  /** 本次新增的回答文字，不是累计全文。 */
  delta?: string | null;
  /** 本次新增的推理文本，与回答 delta 分离。 */
  reasoningDelta?: string | null;
  /** 可选推理签名增量，由目标公共协议写出器映射。 */
  reasoningSignature?: string | null;
  /** 可选角色（通常 assistant），按上游语义输出。 */
  role?: string | null;
  /** 上游结束原因；宿主暂存到 end mapper 完成后输出一次，不能提前丢掉后续 usage。 */
  finishReason?: string | null;
  /** 非负整型用量快照；通常是最新累计值，不是要求宿主逐帧相加的差值。 */
  usage?: {
    /** 输入 token 数。 */
    promptTokens: number;
    /** 输出 token 数。 */
    completionTokens: number;
    /** 总 token 数。 */
    totalTokens: number;
  } | null;
  /** 工具调用增量，每项必须有稳定 index；单帧最多 128 项。 */
  toolCalls?: Array<{
    /** 聚合键，范围 0–1023；跨帧同一调用必须保持一致。 */
    index: number;
    /** 上游工具调用 ID，可在首帧提供。 */
    id?: string;
    /** 函数名称，可在首帧提供。 */
    name?: string;
    /** 参数 JSON 字符串片段；不要把未闭合片段提前 JSON.parse。 */
    arguments?: string;
  }> | null;
  /** 当前流失败信息；宿主不会把错误帧当成功结束，也不会拼接另一条生成请求。 */
  error?: string | null;
  /** 错误类型提示，供公共协议映射使用。 */
  errorType?: string | null;
}

/** event/end mapper 必须同步返回的结果；不得返回 Promise，state 总量最多 512 KiB。 */
export interface MapResult {
  /** 下一帧使用的完整 JSON 状态；保存计数/结束标记等必要信息，不要累计所有正文。 */
  state: Json;
  /** 本帧产生的增量，最多 128 项；无输出也要返回空数组。 */
  chunks: StreamChunk[];
  /** event mapper 确认协议结束时设 true，宿主随后调用一次 end；EOF 是否完整仍由 end 验证。 */
  done?: boolean;
}
/**
 * 六种受支持凭证，与 C# Credential 家族对应。平台必须先在 credentialKinds 声明种类。
 * 读取秘密需 readCredentials/refresh 等许可；不得写入页面、日志、仓库或 job 查询结果。
 * Custom 的嵌套结构应先序列化为字段字符串，不传任意 CLR/JS 对象。
 */
export type Credential =
  | {
      /** API Key 凭证的判别字段。 */
      kind: "ApiKey";
      /** 上游密钥，不能与 Router2API 下游访问 Key 混用。 */
      apiKey: string;
    }
  | {
      /** OAuth 凭证的判别字段。 */
      kind: "OAuth";
      /** 当前访问令牌；是否允许空令牌仅靠 refreshToken 工作由提供方决定。 */
      accessToken: string;
      /** 带时区的访问令牌到期时间；不是积分包有效期。 */
      expiresAt?: string | null;
      /** 可选刷新令牌，提交更新时须保留未变的字段。 */
      refreshToken?: string | null;
      /** 可选身份令牌，按秘密字段处理。 */
      idToken?: string | null;
      /** 上游 UID/账号标识，不是宿主 AccountMetadata.id。 */
      accountId?: string | null;
      /** 提供方站点/域名元数据，例如国内或国际域名；不会自动授权该 HTTP origin。 */
      domain?: string | null;
      /** 可选企业/租户标识。 */
      enterpriseId?: string | null;
      /** 可选昵称；凭证 CAS/刷新可据此同步账号显示名。 */
      nickname?: string | null;
    }
  | {
      /** 自定义凭证；适合提供方有额外站点设置、模型允许表等字段的情况。 */
      kind: "Custom";
      /** 字符串/null 字段表；整个凭证仍受 64 KiB 限制，不能据字段内容扩大宿主权限。 */
      fields: Record<string, string | null>;
    }
  | {
      /** Bearer Token 凭证的判别字段。 */
      kind: "BearerToken";
      /** 上游 Bearer 令牌，发送 Authorization 时通常加 Bearer 前缀。 */
      token: string;
      /** 可选到期时间，ISO 8601 字符串。 */
      expiresAt?: string | null;
    }
  | {
      /** BasicAuth 凭证的判别字段。 */
      kind: "BasicAuth";
      /** 上游用户名，可作为非秘密元数据投影。 */
      username: string;
      /** 上游密码，按秘密字段处理。 */
      password: string;
    }
  | {
      /** Cookie 凭证的判别字段。 */
      kind: "Cookie";
      /** 原始 Cookie 头值；客户端不维护跨账号共享 Cookie 容器。 */
      cookie: string;
    };

/** 宿主持久化的账号状态视图；写状态还需相应权限，不能伪造租约/InFlight 等运行字段。 */
export interface AccountStatus {
  /** 全局资源状态；通常只操作 Active/Disabled/Invalid，能否选择还受冷却和插件策略约束。 */
  state: "Active" | "Cooling" | "Draining" | "Invalid" | "Disabled" | "Removed";
  /** 账号冷却截止时间；设为 null 是明确清除，不是省略字段。 */
  cooldownUntil?: string | null;
  /** 可选临时停用截止时间；不要据此假定 Disabled 会自动变为 Active。 */
  disabledUntil?: string | null;
  /** 账号状态原因；clearCooldown 可用它作为“仍为本次冷却”的条件。 */
  reason?: string | null;
  /** 与最近状态变化关联的 HTTP 状态码，不是宿主尝试结果的全部判据。 */
  lastStatusCode?: number | null;
  /** 持久化失败计数，非负；写入需 setCooldown 权限。 */
  consecutiveFailures: number;
}

/** 账号只读快照；list/get 默认不含 credential，读取后不代表持有可写数据库对象。 */
export interface AccountMetadata {
  /** 宿主账号 ID；调用 get/delete/refresh 时使用它，而不是上游 UID。 */
  id: string;
  /** 所属已声明平台，已有账号不能通过 save 改平台。 */
  platform: string;
  /** 显示名，可能包含个人信息，展示/日志仍需脱敏。 */
  label?: string | null;
  /** 账号/凭证的到期元数据，不是积分包的失效时间。 */
  expiresAt?: string | null;
  /** 已保存凭证种类。 */
  credentialKind: Credential["kind"];
  /** 宿主 CAS 用的修订号，按不透明十进制字符串原样传回，禁止转成 JS Number。 */
  credentialVersion: string;
  /** 普通元数据视图为 null；刷新结果及显式授权的选择输入可包含完整凭据。 */
  credential?: Credential | null;
  /** 非秘密的凭证摘要，例如 OAuth domain/accountId/enterpriseId/nickname；字段随凭证类型变化。 */
  credentialMetadata?: Record<string, Json> | null;
  /** 获取快照时的账号状态；请求执行前宿主仍会执行自己的过滤。 */
  status: AccountStatus;
}

/** save 输入；新建须给 credential，更新只写实际提供的字段，省略字段保留原值。 */
export interface AccountInput {
  /** 省略时由宿主生成 ID；指定 ID 为 1–64 个非控制字符，不能覆盖其他插件账号。 */
  id?: string;
  /** 新建时默认当前平台；只能使用包声明平台，不能更改已有账号平台。 */
  platform?: string;
  /** 显示名，最多 128 字符；null 明确清空，省略保留旧值。 */
  label?: string | null;
  /** 可选到期时间；null 明确清空，凭证自带有效期时注意同步语义。 */
  expiresAt?: string | null;
  /** 新建所需凭证或明确替换的新凭证；并发刷新更应使用 compareExchangeCredential/refresh。 */
  credential?: Credential;
  /** 状态/disabledUntil 另需 disable 权限，其余状态字段另需 setCooldown；不得添加 InFlight/version。 */
  status?: Partial<AccountStatus>;
}

/** 本插件账号能力；所有归属由宿主绑定，输入不能包含自选 pluginKey 来越权。 */
export interface AccountsApi {
  /** 仅 start hook 可用且需 createAnonymousAccount；创建/读取 public 匿名账号，不是绕过上游鉴权。 */
  ensureAnonymous(): Promise<AccountMetadata>;
  /** 仅 Terminal 可用，需 readCurrentCredential 或 accounts.readCredentials；优先读取当前选中账号的最新凭据。 */
  currentCredential(): Promise<Credential>;
  /** 需 accounts.read；默认列出当前平台，可指定本插件其他已声明平台。 */
  list(options?: {
    /** 缺省当前平台，只能指定本包已经声明的平台。 */
    platform?: string;
    /** 默认 false；批量读取秘密还需 readCredentials 权限。仅后端使用，不把此结果直接返回页面或日志。 */
    includeCredentials?: boolean;
  }): Promise<AccountMetadata[]>;
  /** 需 accounts.read；不存在/不属于本插件返回 null，不包含秘密字段。 */
  get(id: string): Promise<AccountMetadata | null>;
  /** 需 accounts.write；新建/字段级更新元数据，状态字段另行授权，返回不含秘密的最新快照。 */
  save(input: AccountInput): Promise<AccountMetadata>;
  /** 需 accounts.write；删除本插件账号，脚本不接触宿主冷却缓存键。 */
  delete(id: string): Promise<void>;
  /** 需 accounts.readCredentials；为模型发现、任务等无“当前账号”场景显式读取凭证。 */
  readCredentials(id: string): Promise<{
    /** 宿主账号 ID。 */
    accountId: string;
    /** 用于下一次 CAS 提交的凭证修订号字符串。 */
    version: string;
    /** 完整秘密凭据，不得直接返回给浏览器。 */
    credential: Credential;
  }>;
  /**
   * 需 accounts.write；仅当版本匹配时更新凭据，保留账号冷却/停用等状态。
   * @param id 本插件账号 ID。
   * @param expectedVersion 先前 readCredentials/accountMetadata 获得的版本字符串。
   * @param credential 完整的新凭证；不是只包含 accessToken 的局部补丁。
   * @returns 成功时的元数据；冲突/已删除时为 null。勿盲目重放有副作用的 OAuth 刷新。
   */
  compareExchangeCredential(id: string, expectedVersion: string, credential: Credential): Promise<AccountMetadata | null>;
  /**
   * 需 accounts.refresh 和 hooks.refreshCredential；进入本宿主账号锁后读取最新凭证，
   * 在独立 Callback Engine 执行命名导出，最后 CAS 提交。禁止在回调里再次 refresh。
   * @param id 要刷新的本插件账号 ID。
   * @returns 含新 credential 的账号快照；该返回值仍是秘密，不能直接返回管理页面。
   */
  refresh(id: string): Promise<AccountMetadata & {
    /** 刷新后的完整秘密凭证，仅供后端继续请求，不直接发给浏览器或写日志。 */
    credential: Credential;
  }>;
  /** 需 accounts.setCooldown；设置最多未来 30 天的冷却，仅动作成功不代表模型请求成功。 */
  setCooldown(id: string, until: string, reason: string, statusCode?: number): Promise<void>;
  /** 需 accounts.setCooldown；仅当账号仍 Active 且冷却原因匹配时解除，返回是否实际更新。 */
  clearCooldown(id: string, expectedReason: string): Promise<boolean>;
  /** 需 accounts.disable；显式停用本插件账号，模型失败通常更应返回 attempt.decision。 */
  disable(id: string, reason: string, statusCode?: number): Promise<void>;
}

/**
 * 状态后端的共同 API：local 是本版本内存，shared 是带插件命名空间的 Redis。
 * local 需 permissions.state，shared 需 permissions.sharedState。未配置 Redis 不退回 local。
 * 所有写入必须有有限 TTL（默认 300 秒）；读取失败与“键不存在”不能混为一谈。
 */
export interface StateApi {
  /** 需 read；报告后端是否已配置，不保证此刻网络正常；local 返回 true。 */
  available(): Promise<boolean>;
  /** 需 read；解析已存 JSON，缺失时返回 null；存储 JSON null 与缺失需用 CAS/putIfAbsent 区分。 */
  get(key: string): Promise<Json>;
  /** 需 read；读取原始字符串，兼容 C# 状态与精确大整数；缺失返回 null。 */
  getString(key: string): Promise<string | null>;
  /** 需 write；保存 JSON，local 最多 64 KiB/值、256 键、1 天，shared 最多 4 MiB/值、30 天。 */
  set(key: string, value: Json, options?: {
    /** 默认 300 秒；local 最多 86400 秒，shared 最多 2592000 秒，必须为正整数。 */
    ttlSeconds?: number;
  }): Promise<void>;
  /** 需 write；不做 JSON 包装，保存原始字符串；之后用 getString，而不是假设 get 一定能解析。 */
  setString(key: string, value: string, options?: {
    /** 默认 300 秒；覆盖值时更新到期时间，最大值取决于 local/shared 后端。 */
    ttlSeconds?: number;
  }): Promise<void>;
  /** 需 write；删除本插件逻辑键，不允许传其他插件/宿主的真实 Redis key。 */
  remove(key: string): Promise<void>;
  /** 需 read；返回带时区的到期时间，键缺失/过期时为 null。 */
  expiry(key: string): Promise<string | null>;
  /** 需 write；键不存在时才原子写入并设 TTL，返回是否写入，不能据此承诺无限期分布式锁。 */
  putIfAbsent(key: string, value: Json, options?: {
    /** 仅写入成功时设置的 TTL，默认 300 秒；不会为已存在键续期。 */
    ttlSeconds?: number;
  }): Promise<boolean>;
  /**
   * 需 write；对整数值原子递增并更新 TTL，非整数值/溢出拒绝，不覆盖坏数据。
   * @param key 逻辑键，最多 128 个非控制字符。
   * @param delta 默认 "1"；Number 必须是安全整数，大数使用十进制字符串。
   * @param options TTL 设置，读取计数可用 getString，increment(key,"0") 仍会续 TTL。
   * @returns 精确 Int64 字符串；不要经 JSON Number 读取大计数。
   */
  increment(key: string, delta?: string | number, options?: {
    /** 每次递增成功都更新 TTL，默认 300 秒；delta=0 也不是纯只读查询。 */
    ttlSeconds?: number;
  }): Promise<string>;
  /**
   * 需 write；按已序列化字符串比较后原子替换/删除，不是“语义等价 JSON”比较。
   * @param expected undefined 表示必须缺失；null 表示已存 JSON null，对象键顺序也影响比较。
   * @param value undefined 表示删除；其他 JSON 值写入并设置 TTL。
   * @returns 是否满足前置条件并完成更新；false 不应被当作写入成功。
   */
  compareExchange(key: string, expected: Json | undefined, value: Json | undefined, options?: {
    /** 替换成功时的新 TTL，默认 300 秒；比较失败不会续期，删除仍校验选项。 */
    ttlSeconds?: number;
  }): Promise<boolean>;
}

/** selectAccounts 返回的偏好；只能对输入候选删减/排序，不能绕过宿主硬过滤。 */
export interface AccountPreference {
  /** 必须来自本批 candidates 且不可重复。 */
  accountId: string;
  /** 默认 true；false 明确排除此账号，也可不返回该账号。 */
  eligible?: boolean;
  /** Int32 权重，默认 0；同截止时间时较大值优先，相同权重再随机打散。 */
  weight?: number;
  /** 主排序时间，较早优先；null/省略无到期优先。是否过期、是否有剩余积分由插件自己判断。 */
  preferredExpiry?: string | null;
}
/** 批量选号输入；先经过宿主平台/停用/冷却等过滤，不是完整账号数据库。 */
export interface AccountSelectionInput {
  /** 默认只给元数据；显式 readCredentials 权限才包含 credential，勿再逐账号发 HTTP。 */
  candidates: AccountMetadata[];
}

/** 本版本任务的只读状态快照，不包含原始输入、宿主任务对象或 CLR 堆栈。 */
export interface JobSnapshot {
  /** 宿主生成的任务 ID，不可在另一插件/版本中复用。 */
  id: string;
  /** 清单 jobs/tasks 的已注册名称。 */
  name: string;
  /** 任务所属平台。 */
  platform: string;
  /** 可选活跃去重键；完成后的相同键可以创建新任务。 */
  key?: string | null;
  /** 业务状态；取消请求不等于立即退出，排空仍以实际执行 Task 完成为准。 */
  state: "Queued" | "Running" | "Completed" | "Failed" | "Cancelled";
  /** 入队时间，ISO 8601。 */
  queuedAt: string;
  /** 真正获得执行槽后的时间，排队时可为 null。 */
  startedAt?: string | null;
  /** 执行结束时间，尚未结束时可为 null。 */
  finishedAt?: string | null;
  /** 最近一次进度快照，最多 64 KiB；不能放入 token 等秘密。 */
  progress?: Json;
  /** 最终 JSON 结果，最多 256 KiB；同名 Cron job 返回 {succeeded:true} 而非 Cron 的 JS 返回值。 */
  result?: Json;
  /** 失败/取消摘要，不是可重试指令，也不包含 CLR Exception。 */
  error?: string | null;
}

/** 本插件版本的后台任务 API；任务独立于发起它的 HTTP 请求，但归宿主版本生命周期所有。 */
export interface JobsApi {
  /**
   * 需 jobs.start；入队后返回，不等待完成。最多 128 个未结束任务，本版本一个执行槽。
   * @param name 已声明的 job 名称，或同名 Cron 任务（后者仍走原生 task invoker/任务锁）。
   * @param input 最多 64 KiB JSON；优先传账号 ID，而不是捕获某次 invocation/source/凭证。
   * @param options 同平台/同名/同 key 的活跃任务会返回原任务；不会替换其输入。
   * @returns 排队/运行快照；调用方需另行查询最终结果。
   */
  start(name: string, input?: Json, options?: {
    /** 1–128 个非控制字符的可选去重键。 */
    key?: string;
    /** 默认当前平台，只能选本插件注册过相应任务的平台。 */
    platform?: string;
  }): Promise<JobSnapshot>;
  /** 需 jobs.read；本版本不存在/已清理的任务返回 null，不能读取其他版本的任务。 */
  get(id: string): Promise<JobSnapshot | null>;
  /** 需 jobs.read；按入队时间倒序返回保留记录，已结束记录最多 128 条且最多保留一小时。 */
  list(): Promise<JobSnapshot[]>;
  /** 需 jobs.cancel；请求取消运行/排队任务，返回是否接受，不代表任务已经结束。 */
  cancel(id: string): Promise<boolean>;
  /** 需 jobs.read；等待实际结束，取消等待不取消 job；不能在 Job handler 内嵌套 wait。 */
  wait(id: string): Promise<JobSnapshot | null>;
  /** 仅 Job 阶段可用；替换当前任务的进度快照，无需把 job ID 交回宿主。 */
  progress(value: Json): Promise<void>;
}

/** 模型完成对象，与 C# AdapterCompletion 对齐；公共 API 的 JSON/SSE 包装交给宿主。 */
export interface Completion {
  /** 平台内模型 ID；通常使用 ctx.request.model。 */
  model: string;
  /** 完整回答文字；仅工具输出时可为 null。 */
  content?: string | null;
  /** 结束原因，缺省 stop；不要用成功 stop 掩盖上游截断。 */
  finishReason?: string;
  /** 非负整型用量快照；未知就省略，不伪造为上游已计费数量。 */
  usage?: {
    /** 输入 token。 */
    promptTokens: number;
    /** 输出 token。 */
    completionTokens: number;
    /** 总 token。 */
    totalTokens: number;
  };
  /** 聚合后的工具调用，不再是 SSE 分片。 */
  toolCalls?: Array<{
    /** 稳定工具序号。 */
    index: number;
    /** 上游调用 ID。 */
    id?: string;
    /** 函数名。 */
    name?: string;
    /** 完整参数字符串，保留原协议 JSON 语义。 */
    arguments?: string;
  }>;
  /** 完整推理文本，与 content 分离。 */
  reasoningContent?: string | null;
  /** 可选推理签名，按上游协议保留。 */
  reasoningSignature?: string | null;
}

/** invoke 的返回契约；response 决定如何写出，attempt 决定是否申请资源动作。 */
export interface InvocationResult {
  /** 只能选择一种响应形态；raw source 和自建 raw bytes 不是同一种所有权。 */
  response:
    | {
        /** 标准非流式完成；若下游请求流，宿主会转为标准增量输出。 */
        kind: "completion";
        /** 缺省 200，必须为成功状态。 */
        statusCode?: number;
        /** 统一完成结果。 */
        completion: Completion;
      }
    | {
        /** 非流式错误，不可冒充成功 completion。 */
        kind: "error";
        /** 错误 HTTP 状态码，范围 400–599。 */
        statusCode: number;
        /** 给客户端的错误说明，不得含秘密。 */
        message: string;
        /** 可选错误类型，缺省由宿主提供 upstream_error。 */
        errorType?: string;
      }
    | {
        /** 宿主读 SSE 并调用同步 mapper；下游非流式时使用同一管线聚合。 */
        kind: "mappedStream";
        /** 缺省 200，mappedStream 要求成功状态。 */
        statusCode?: number;
        /** 当前 http.open 返回的句柄；一条响应只移交一个 source。 */
        source: string;
        /** 清单 streamMappers 中的名称，不是任意代码表达式。 */
        mapper: string;
        /** 该条流的初始 JSON 状态，不与其他调用共享。 */
        state: Json;
      }
    | {
        /** 直接透传上游字节，状态码/Content-Type 来自 source。 */
        kind: "raw";
        /** 本次调用仍持有的 source 句柄。 */
        source: string;
      }
    | {
        /** 自建原始缓冲响应；它不是可跨调用的流对象。 */
        kind: "raw";
        /** 返回给下游的 HTTP 状态。 */
        statusCode: number;
        /** UTF-8 文本正文，与 bodyBase64 选择其一。 */
        bodyText?: string;
        /** 原始响应字节的 Base64，与 bodyText 选择其一。 */
        bodyBase64?: string;
        /** 合法 MIME 类型，缺省 application/octet-stream。 */
        contentType?: string;
        /** 可选用量，不从任意 raw 字节自动推断。 */
        usage?: Completion["usage"];
      };
  /** 显式决策或预览版兼容分类；不替代响应自身的成功/失败状态。 */
  attempt: AttemptResult;
}

/** log.write 输入，插件/平台/traceId/taskName 由宿主上下文关联，不能伪造归属。 */
export interface LogEntry {
  /** 最多 2000 字符的说明；自动脱敏是兜底，作者仍不应直接记录秘密。 */
  message: string;
  /** 默认 Information；是否入库还受宿主最低日志级别控制。 */
  level?: "Debug" | "Information" | "Warning" | "Error";
  /** 事件代码，默认 js.log，最多 128 字符。 */
  eventType?: string;
  /** 可选关联账号 ID，缺省使用当前尝试账号。 */
  accountId?: string;
  /** 可选模型，缺省使用当前尝试模型。 */
  model?: string;
  /** 可选 HTTP 状态码。 */
  statusCode?: number;
  /** 可选非负毫秒耗时。 */
  durationMs?: number;
  /** 最多 64 KiB 结构化 JSON，不写完整请求头/凭证。 */
  details?: Json;
}

/** tasks.writeLog 的账号任务明细，需 tasks.writeLog 权限；这不是后台 job 的状态更新 API。 */
export interface TaskLogEntry {
  /** 1–128 字符的任务名称，使用清晰稳定的业务代码。 */
  taskName: string;
  /** 业务状态字符串，例如 Success/Failed/Cancelled，不会自动触发重试。 */
  status: string;
  /** 可选账号关联标识。 */
  accountId?: string;
  /** 可选说明，避免包含秘密。 */
  message?: string;
  /** 可选错误摘要，不传 Exception 或完整堆栈。 */
  error?: string;
  /** 可选 JSON 明细，最多 64 KiB。 */
  details?: Json;
  /** 非负耗时，缺省 0。 */
  durationMs?: number;
  /** ISO 8601 开始时间，缺省由宿主填当前时间。 */
  startedAt?: string;
  /** ISO 8601 结束时间，缺省由宿主填当前时间。 */
  finishedAt?: string;
}
/**
 * 宿主按调用阶段创建的上下文，不是浏览器 window，也不是可长期保存的服务对象。
 * 不同 invoke/models/endpoint/job 调用通常使用不同 Engine，不能靠模块变量共享状态。
 * 字段是当前调用的 JSON 投影；改写 request/account/标识不会直接修改宿主实体或扩大权限。
 */
export interface PluginContext {
  /** 稳定插件键，对应安装目录名；实际归属由宿主闭包绑定，不信任脚本修改后的值。 */
  pluginKey: string;
  /** 本次加载版本的标识，同包平台共享；用于诊断，不是可自选的资源命名空间。 */
  generationId: string;
  /** 清单中的插件版本字符串。 */
  pluginVersion: string;
  /** 当前终端/端点/job 所属平台。 */
  platform: string;
  /** 本次独立引擎调用标识；不是长任务 ID，也不能拿来恢复旧 source。 */
  invocationId: string;
  /** 模型请求的追踪 ID；非 Terminal 场景可能没有。 */
  traceId?: string;
  /** 管理端点 query 参数；默认是字符串值，不是完整 HttpContext。 */
  query?: Record<string, string>;
  /** 管理端点已解析的 JSON 正文；不要假定它已经满足自己的业务 schema。 */
  body?: Json;
  /** 当前 Cron/job 名称，其他阶段可能没有。 */
  task?: string;
  /** 仅命名 JS job 有此上下文；同名 Cron 的后台入口仍执行 Task handler。 */
  job?: {
    /** 当前宿主后台任务 ID，可用于诊断；更新进度使用 jobs.progress。 */
    id: string;
  } | null;
  /** 宿主决定的阶段；Selection 只许读状态/同步工具，Callback 禁止递归刷新，Stop 不能恢复已关停能力。 */
  phase: "Terminal" | "Control" | "Task" | "Job" | "Selection" | "Callback" | "Stop";
  /** Terminal/Selection 的标准请求投影，控制面和 job 不能假定存在。 */
  request?: {
    /** 已去掉平台前缀的模型 ID；提供方自己的 cn/global 等内部前缀仍由插件解释。 */
    model: string;
    /** 下游请求路径，例如 /v1/chat/completions、/v1/responses、/v1/messages。 */
    endpoint: string;
    /** 下游是否请求流式输出；上游是否强制 SSE 由提供方协议决定。 */
    stream: boolean;
    /** 可选的下游输出 token 预算，不能因为重试而悄悄扩大/降档。 */
    maxTokens?: number;
    /** 可选温度参数，能力支持由提供方决定。 */
    temperature?: number;
    /** 标准化消息；保留多模态、工具与推理字段，不要只拼接 content 丢掉其他部分。 */
    messages: Array<{
      /** 消息角色，如 system/developer/user/assistant/tool。 */
      role: string;
      /** 文本投影，多模态请求可能依赖 contentParts。 */
      content: string;
      /** 原顺序的内容块，包括图片、文件等 JSON 元数据。 */
      contentParts?: Json[];
      /** 其他标准消息字段（工具、推理、签名等）由当前共享契约提供，使用前做类型检查。 */
      [key: string]: unknown;
    }>;
    /** 工具声明的 JSON 列表，不能把上游工具调用结果混在声明中。 */
    tools: Json[];
    /** 共享解析器未单独归类的请求扩展，插件需自己做业务校验。 */
    extensions: Record<string, Json>;
    /** 宿主允许的非敏感下游头；不是包含管理员 Cookie/Authorization 的全量头。 */
    headers: Record<string, string>;
    /** 当前原始 JSON 正文的宿主句柄；仅 Terminal 原请求可用，配合 http.originalJson 保留精度。 */
    originalBodyRef?: string | null;
  };
  /** 当前选中账号/刷新回调账号的元数据快照；普通模型投影不含 credential 秘密。 */
  account?: AccountMetadata | null;
  /** 受权限检查的 HTTP、固定客户端和 source API。 */
  http: HttpApi;
  /** 顶层方法兼容旧 API，等价于 local；共享状态必须显式使用 shared。 */
  state: StateApi & {
    /** 本插件版本的有界内存状态，卸载后不保留。 */
    local: StateApi;
    /** 带插件命名空间的 Redis 状态，未配置/故障不静默转为 local。 */
    shared: StateApi;
  };
  /** 持久化账号能力，按每个操作分别授权。 */
  accounts: AccountsApi;
  /** 本插件平台模型目录及公共只读模型元数据。不要在 getModels 内再次刷新自身目录形成递归。 */
  models: {
    /** 需 models.read；默认当前平台，可指定本插件其他平台，遵守模型缓存 TTL。 */
    list(platform?: string): Promise<ModelDescriptor[]>;
    /** 需 models.read；读取 models.dev 等公共能力/协议元数据，可能触发宿主自己的网络刷新。 */
    metadata(): Promise<{
      /** 模型能力快照的 UTC 时间。 */
      updatedAt: string;
      /** 公共模型能力列表，不含账号 token。 */
      models: Array<{
        /** 公共模型标识。 */
        id: string;
        /** 元数据来源平台标识，不是允许脚本访问该插件账号的授权。 */
        platform: string;
        /** 元数据平台显示名。 */
        platformName: string;
        /** 模型显示名。 */
        displayName: string;
        /** 上下文窗口。 */
        contextWindow: number;
        /** 输入 token 上限。 */
        inputLimit: number;
        /** 输出 token 上限。 */
        outputLimit: number;
        /** 是否声明支持推理。 */
        supportsReasoning: boolean;
        /** 允许的推理档位，未知则为空。 */
        reasoningLevels?: string[] | null;
        /** 可选推理 token 上限。 */
        reasoningTokenLimit?: number | null;
      }>;
      /** 模型到协议名称的公共映射；不能据此跳过自身提供方的协议验证。 */
      protocols?: Record<string, string> | null;
      /** 协议元数据快照时间。 */
      protocolsUpdatedAt?: string | null;
    }>;
    /** 需 models.invalidate；只使本插件平台缓存失效，不直接请求所有上游。 */
    invalidate(platform?: string): Promise<void>;
    /** 需 models.refresh；调用指定本插件平台的 getModels，并传 forceRefresh=true。 */
    refresh(platform?: string): Promise<ModelDescriptor[]>;
  };
  /** 已声明 Cron 任务的同步执行与日志能力；长任务从管理端优先使用 jobs.start。 */
  tasks: {
    /** 需 tasks.run；等待原生 task invoker/任务锁的结果，不能从 Task 或 Job 内嵌套调用。 */
    run(name: string): Promise<boolean>;
    /** 需 tasks.writeLog；写入本插件的逐账号任务明细，不改变 job 状态。 */
    writeLog(entry: TaskLogEntry): Promise<void>;
  };
  /** 版本级后台任务能力；不是允许脚本创建任意线程/计时器的接口。 */
  jobs: JobsApi;
  /** 有界的同步纯计算工具，可在 mapper 中使用；需相应 crypto 权限，不会执行网络。 */
  crypto: {
    /** 需 crypto.random；返回原生生成的随机 UUID 字符串。 */
    randomUUID(): string;
    /** 需 crypto.hash；按 UTF-8 对文本计算哈希，返回小写十六进制，不是加密。 */
    hash(algorithm: "SHA256" | "SHA384" | "SHA512", text: string): string;
    /** 需 crypto.hash；SHA256 的便利形式，可构造稳定会话亲和性。 */
    sha256(text: string): string;
    /** 需 crypto.hmac；按 UTF-8 编码 key/text 计算 HMAC-SHA256，返回小写十六进制。 */
    hmacSha256(key: string, text: string): string;
  };
  /** 同步编码工具，需 crypto.encoding；不是对 token/密码的加密存储。 */
  encoding: {
    /** 将 UTF-8 文本编码为 Base64。 */
    toBase64(text: string): string;
    /** Base64 解码为严格 UTF-8 文本；任意二进制使用 HTTP bodyBase64，不要强行解码成文字。 */
    fromBase64(text: string): string;
    /** 十六进制字节转为 Base64，输入非法时拒绝。 */
    hexToBase64(text: string): string;
  };
  /** 同步 .NET decimal 运算，需 crypto.decimal；输入/输出用十进制字符串，溢出/除零报错。 */
  decimal: {
    /** 精确十进制加法，例如 "0.1"+"0.2" 返回 "0.3"。 */
    add(left: string, right: string): string;
    /** 十进制减法。 */
    subtract(left: string, right: string): string;
    /** 十进制乘法，受 .NET decimal 范围约束。 */
    multiply(left: string, right: string): string;
    /** 十进制除法，不承诺无限精度。 */
    divide(left: string, right: string): string;
    /** 比较两个十进制字符串，返回负数/0/正数。 */
    compare(left: string, right: string): number;
  };
  /** 同步 URL 解析/组合，不访问网络，也不授予所得 URL 的请求权限。 */
  url: {
    /** 解析绝对 URI；发 HTTP 时仍需再次通过 http 的 HTTP(S)/origin 限制。 */
    parse(text: string): {
      /** 规范化完整 URI。 */
      href: string;
      /** scheme/host/port 组成的 authority；批准动态目标应使用精确 HTTP(S) origin。 */
      origin: string;
      /** 协议名。 */
      scheme: string;
      /** 主机名。 */
      host: string;
      /** 有效端口号。 */
      port: number;
      /** 绝对路径。 */
      path: string;
      /** 含前导 ? 的查询部分（若有）。 */
      query: string;
      /** 含前导 # 的片段部分（若有）；HTTP 发送不接受片段。 */
      fragment: string;
    };
    /** 用绝对 base 解析 relative，不做任何网络授权或下载。 */
    resolve(base: string, relative: string): string;
  };
  /** 纯 JSON 结果构造函数；只减少嵌套对象书写，不执行 HTTP、重试或资源动作。 */
  reply: {
    /** 构造 200 completion 与健康决策；下游要求流时由宿主转换。 */
    completion(completion: Completion): InvocationResult;
    /** 构造错误响应，默认 Upstream 且无重试/惩罚；特殊动作必须显式提供 decision。 */
    error(statusCode: number, message: string, decision?: AttemptDecision): InvocationResult;
    /** 移交本次 source 的 raw 描述；默认健康决策不会替作者识别 HTTP/业务错误。 */
    raw(source: HttpSource, decision?: AttemptDecision): InvocationResult;
    /** 构造 mappedStream 与健康决策；只应在上游成功且已声明 mapper 时使用。 */
    mappedStream(source: HttpSource, mapper: string, state: Json): InvocationResult;
  };
  /** 当前调用关联的诊断日志能力，低于宿主最低级别的日志可能不入库。 */
  log: {
    /** 等待日志写入；不要把日志失败误分类为代理故障，必要时在业务边界显式处理。 */
    write(entry: LogEntry): Promise<void>;
  };
  /** 可取消等待，0–300000 毫秒；仍占当前逻辑调用配额，不会启动后台任务或延长总截止时间。 */
  delay(milliseconds: number): Promise<void>;
  /** 管理端点 JSON 返回值构造器，不用于模型输出；宿主仍校验状态/正文是否可序列化。 */
  json<T>(statusCode: number, body?: T): {
    /** 管理端点 HTTP 状态，当前 JS 端点支持 200–599（包括 204）。 */
    statusCode: number;
    /** 可序列化正文，204 由宿主按无正文处理。 */
    body?: T;
    /** 固定为 application/json，不是任意 HTTP 响应对象。 */
    contentType: "application/json";
  };
}

/** 清单中的命名导出映射；值是导出名，不是路径、JS 表达式或待 eval 的代码。 */
export interface HookNames {
  /** 模型入口 (ctx) → InvocationResult；每个有效平台必须有此导出。 */
  invoke: string;
  /** 模型发现 (ctx,{forceRefresh,requestedModel}) → ModelDescriptor[]，一次最多 2000 个模型。 */
  getModels?: string;
  /** 校验 (ctx,credential) → {success,error?}；无此 hook 时只做凭证种类匹配。 */
  validateCredential?: string;
  /** 整批选号 (ctx,{candidates}) → AccountPreference[]，可 await 只读状态，不可执行 HTTP/写入。 */
  selectAccounts?: string;
  /** 刷新 (ctx,包含凭证的最新账号) → 完整 Credential，由宿主单独借 Callback Engine 调用。 */
  refreshCredential?: string;
  /** 加载时动态主页面 (ctx) → {title,html,version}，HTML 最多 1 MiB；不是每次打开页面都运行。 */
  getMainPage?: string;
  /** 候选版本启动 (ctx) → void；发生在切换/注册新平台之前，勿依赖新平台已对外可用。 */
  start?: string;
  /** 已进入 start 的版本在停止时调用 (ctx) → void；作清理，不启动新的长后台工作。 */
  stop?: string;
}

/** 模型业务尝试策略，宿主可进一步限制；不等同于独立 HTTP pool 的重试配置。 */
export interface ExecutionPolicy {
  /** 总尝试数 1–35，默认 1；不是“额外重试次数”。 */
  maxAttempts?: number;
  /** 建立响应前每次尝试 1–60 秒，默认 60，并受宿主 SetupTimeout 限制。 */
  attemptTimeoutSeconds?: number;
  /** 建立响应前整个尝试序列 1–180 秒，默认 180；SSE 体阶段另有 ResponseTimeout。 */
  totalTimeoutSeconds?: number;
  /** 宿主实际观察到传输异常时的默认动作，不解释上游积分/鉴权业务码。 */
  transportFailure?: {
    /** 默认 true，仅在仍有业务尝试预算时生效。 */
    retry?: boolean;
    /** 默认 true，但必须确有本次代理故障证据，直连错误不惩罚无关节点。 */
    cooldownProxy?: boolean;
    /** 默认 0（不冷却账号），范围 0–86400 秒，在每次故障时计算截止时间。 */
    accountCooldownSeconds?: number;
  };
}

/** 包内一个平台的配置；平台名称必须全局无冲突，策略在宿主按 pluginKey+platform 隔离。 */
export interface PlatformManifest {
  /** 1–64 字符的小写标识，允许字母/数字/点/下划线/连字符，必须以字母或数字开头。 */
  name: string;
  /** 可选显示名，缺省使用插件 name。 */
  displayName?: string;
  /** 可接受的凭证类型，至少一种。 */
  credentialKinds: Credential["kind"][];
  /** 模型缓存秒数 0–86400，默认 300，0 禁用宿主模型缓存。 */
  modelCacheTtlSeconds?: number;
  /** 可选 HTTP(S) 探测地址元数据，不会因声明就自动批准普通 JS 出站请求。 */
  probeEndpoint?: string;
  /** 平台级 hooks 整体替代包级 hooks，不是逐字段合并；覆写时仍需 invoke。 */
  hooks?: HookNames;
  /** 平台级 policy 整体替代包级 policy；省略字段使用该 policy 的默认值。 */
  policy?: ExecutionPolicy;
}

/**
 * plugin.json 的类型说明；真正的校验在宿主。未知字段会被拒绝，不能靠写配置实现尚不存在的能力。
 * 开发清单 entry 可指向 TS；发行清单必须引用打包后的 ESM。修改权限后也需重新构建/加载。
 */
export interface PluginManifest {
  /** 当前清单结构版本。 */
  schemaVersion: 1;
  /** 稳定插件键，格式同平台标识，必须与安装目录名一致。 */
  id: string;
  /** 非空显示名，不用于资源归属。 */
  name: string;
  /** 插件简介，用于宿主管理卡片和发行索引展示。 */
  description?: string;
  /** 非空业务版本，建议使用语义版本；不决定宿主 Jint/NuGet 版本。 */
  version: string;
  /** 运行时固定 Jint，不能在包中指定 Node 或另一个 CLR 解释器。 */
  runtime: "jint";
  /** JS 接口版本；新包用 1，既有 1-preview 继续兼容。 */
  hostApi: "1" | "1-preview";
  /** 相对入口路径；构建后固定为 server/plugin.mjs，宿主源码上限 2 MiB。 */
  entry: string;
  /** 单个自包含 ESM bundle，生产不补装依赖、不提供运行时模块文件加载。 */
  format: "esm-bundle";
  /** 单平台写法；多平台使用 platforms，不要依赖两者同时存在的优先级。 */
  platform?: PlatformManifest;
  /** 多平台写法，1–16 个且名称唯一；未指定归属的端点/任务属于第一个平台。 */
  platforms?: PlatformManifest[];
  /** 包级默认 hooks，平台可整体覆写。 */
  hooks?: HookNames;
  /** 包级默认模型尝试策略，平台可整体覆写。 */
  policy?: ExecutionPolicy;
  /** 能力白名单，省略即不授权；清单授权不能绕过阶段/归属检查。 */
  permissions?: {
    /** 出站网络配置；不使用通配符替代真实 API 调用清单。 */
    http?: {
      /** 精确 HTTP(S) origin（scheme/host/port），不得有通配符、userinfo、路径、query 或 fragment。 */
      origins?: string[];
      /** 明确允许的路由；pool 默认无节点即失败，attempt 延续宿主现有绑定行为。 */
      routes?: Array<"direct" | "pool" | "attempt">;
      /** 默认 false；允许管理端点维护本插件 SQLite 中的额外精确 origin 授权。 */
      manageOrigins?: boolean;
    };
    /** 账号元数据读、凭据读、写、刷新、冷却、停用分别声明；write 不隐式授予状态权限。 */
    accounts?: Array<"read" | "readCredentials" | "write" | "refresh" | "setCooldown" | "disable">;
    /** local 状态的读/写许可。 */
    state?: Array<"read" | "write">;
    /** Redis shared 状态的独立许可，不因 local 可用而自动获得。 */
    sharedState?: Array<"read" | "write">;
    /** 模型读、强制刷新、缓存失效分别授权。 */
    models?: Array<"read" | "refresh" | "invalidate">;
    /** 等待执行已声明 Cron 任务、写任务明细的许可；不授予任意 .NET Task 创建能力。 */
    tasks?: Array<"run" | "writeLog">;
    /** job 启动、状态读取/等待、取消的许可。 */
    jobs?: Array<"start" | "read" | "cancel">;
    /** 同步工具分组许可；URL 纯解析不需要额外网络许可，但请求仍需授权。 */
    crypto?: Array<"random" | "hash" | "hmac" | "encoding" | "decimal">;
    /** 允许 start 调用 ensureAnonymous；不是对任意上游的匿名访问许可。 */
    createAnonymousAccount?: boolean;
    /** 预览兼容许可，仅允许 Terminal 读取当前账号凭证，不等于 accounts.readCredentials。 */
    readCurrentCredential?: boolean;
  };
  /** JSON 管理端点列表，同一包的 method/path 不得重复。 */
  endpoints?: Array<{
    /** GET/POST/PUT/PATCH/DELETE/HEAD；清单不支持 OPTIONS 管理端点。 */
    method: string;
    /** 插件前缀内相对路径，最多 200 字符，禁止 ..、反斜杠、query、fragment 和 api/admin 前缀。 */
    path: string;
    /** 导出签名 (ctx) → ctx.json(status, body)，不是 ASP.NET IResult。 */
    handler: string;
    /** 归属平台，默认包内第一个。 */
    platform?: string;
    /** 默认 AdminSession；当前 Catalog 对非 Internal 管理路由统一要求管理员/CSRF，不能靠此值开放匿名路由。 */
    auth?: "AdminSession" | "Internal" | "Anonymous" | "ApiKey" | "AdminSessionOrApiKey" | "Custom";
  }>;
  /** 原生 Cron 任务，也可通过同名 jobs.start 在后台运行，仍使用原生 task invoker。 */
  tasks?: Array<{
    /** 同平台唯一的小写任务标识。 */
    name: string;
    /** 导出签名 (ctx) → void；Cron 返回值不会作为任务业务结果保留。 */
    handler: string;
    /** 中国标准时间的五/六字段表达式；秒位必须为固定数字，不支持完整 Quartz 语法。 */
    cron: string;
    /** 归属平台，默认包内第一个。 */
    platform?: string;
    /** 1–3600 秒，默认 60；当前原生 Cron 锁 TTL 为 30 分钟，无自动续租保证。 */
    timeoutSeconds?: number;
    /** 管理页显示说明，不作为业务执行参数。 */
    description?: string;
  }>;
  /** 明确声明的命名 job；不依赖 HTTP 生命周期，不接受任意 JS 函数作为参数。 */
  jobs?: Array<{
    /** 同平台唯一名称，也不能与同平台的 Cron 后台入口重名。 */
    name: string;
    /** 导出签名 (ctx,input) → Json，可报告进度；每次执行使用独立 Engine。 */
    handler: string;
    /** 归属平台，默认包内第一个。 */
    platform?: string;
    /** 1–3600 秒，默认 1800；排队结束后开始计执行时限。 */
    timeoutSeconds?: number;
    /** 可选说明。 */
    description?: string;
  }>;
  /** 静态主页面；没有 page 时也可用 hooks.getMainPage 动态生成加载期页面。 */
  page?: {
    /** 页面标题。 */
    title: string;
    /** 自包含 HTML 相对路径，上限 1 MiB；构建后统一为 ui/index.html。 */
    entry: string;
  };
  /** 名称到同步流转换导出的映射，最多 32 个；名称格式同小写标识。 */
  streamMappers?: Record<string, {
    /** 同步 (frame,state) → MapResult，处理上游事件/协议完成标记。 */
    event: string;
    /** 同步 ({reason:"protocol"|"eof"},state) → MapResult，正常 EOF/协议结束时执行一次。 */
    end: string;
    /** 可选同步 (completion) → Completion，仅在非流式聚合收尾时执行。 */
    completion?: string;
  }>;
}
