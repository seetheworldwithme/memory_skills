export class DomainError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "DomainError";
  }
}

export class NotFoundError extends DomainError {
  constructor(message: string) {
    super("NOT_FOUND", 404, message);
    this.name = "NotFoundError";
  }
}

/**
 * LLM 调用的供应商无关错误分类。
 * 任何 Provider 实现都必须把厂商特有的错误归入这些类别，
 * 不得把供应商的响应类型或原始错误对象泄漏给领域服务。
 */
export type LlmErrorKind =
  | "timeout" // 单次尝试超过配置的超时时间
  | "canceled" // 调用方主动取消
  | "rate_limited" // 供应商限流，可按退避策略重试
  | "invalid_response" // 响应不是约定的结构（非法 JSON、未通过 Schema 校验等）
  | "network" // 网络层失败（连接失败、DNS 等）
  | "server_error" // 供应商服务端错误（5xx、408）
  | "auth" // 鉴权失败（密钥缺失或无效）
  | "config" // 本地配置错误（Provider 未注册、参数非法等）
  | "unknown"; // 未分类错误，保守起见不重试

/** 每类错误对应的稳定错误码、HTTP 语义与默认可重试性。 */
const LLM_ERROR_PROFILES: Record<LlmErrorKind, { code: string; status: number; retryable: boolean }> = {
  timeout: { code: "LLM_TIMEOUT", status: 504, retryable: true },
  canceled: { code: "LLM_CANCELED", status: 499, retryable: false },
  rate_limited: { code: "LLM_RATE_LIMITED", status: 429, retryable: true },
  invalid_response: { code: "LLM_INVALID_RESPONSE", status: 502, retryable: false },
  network: { code: "LLM_NETWORK_ERROR", status: 503, retryable: true },
  server_error: { code: "LLM_SERVER_ERROR", status: 502, retryable: true },
  auth: { code: "LLM_AUTH_ERROR", status: 500, retryable: false },
  config: { code: "LLM_CONFIG_ERROR", status: 500, retryable: false },
  unknown: { code: "LLM_UNEXPECTED", status: 500, retryable: false },
};

/**
 * LLM Provider 错误。
 * message 必须是稳定模板：不得拼接模型响应正文、Prompt 内容或任何密钥，
 * 否则错误信息会在日志与事件中泄漏敏感数据。
 */
export class LlmProviderError extends DomainError {
  readonly kind: LlmErrorKind;
  readonly retryable: boolean;
  /** 供应商通过 Retry-After 建议的等待毫秒数；重试装饰器会优先采用它。 */
  readonly retryAfterMs?: number;

  constructor(
    kind: LlmErrorKind,
    message: string,
    options: { retryable?: boolean; retryAfterMs?: number; cause?: unknown } = {},
  ) {
    const profile = LLM_ERROR_PROFILES[kind];
    super(profile.code, profile.status, message);
    this.name = "LlmProviderError";
    this.kind = kind;
    this.retryable = options.retryable ?? profile.retryable;
    if (options.retryAfterMs !== undefined) this.retryAfterMs = options.retryAfterMs;
    if (options.cause !== undefined) this.cause = options.cause;
  }
}

