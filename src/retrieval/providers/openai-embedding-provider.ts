import { LlmProviderError } from "../../errors.js";
import { llmErrorForHttpStatus } from "../../llm/provider.js";
import type { EmbeddingProvider, EmbeddingRequest, EmbeddingResult } from "../types.js";

export interface OpenAiCompatibleEmbeddingProviderOptions {
  model: string;
  /** 兼容端点地址，默认 https://api.openai.com/v1；也可指向任何 OpenAI 兼容服务。 */
  baseUrl?: string;
  /** 由 Registry 从环境变量读取后注入；绝不进入日志、指标或错误消息。 */
  apiKey: string;
  /** 单次尝试超时毫秒数，默认 30000。 */
  timeoutMs?: number;
  /** 额外重试次数，默认 1；仅对可重试错误生效，重试间固定退避 200ms。 */
  maxRetries?: number;
  /** 可选单价（每百万 Token，美元），按输入 Token 折算。 */
  costPerMillionTokens?: { input?: number };
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** 可重试的 Embedding 错误类别：超时、限流、网络与供应商服务端错误。 */
const RETRYABLE_KINDS = new Set(["timeout", "rate_limited", "network", "server_error"]);
/** 重试间固定退避毫秒数；Embedding 调用位于召回路径，退避不宜过长。 */
const RETRY_BACKOFF_MS = 200;

/**
 * OpenAI 兼容 Embedding Provider：走 /embeddings 协议。
 * 实现约束与 OpenAiCompatibleProvider 相同：只用全局 fetch、不依赖厂商 SDK、
 * 错误消息保持稳定模板不拼接响应正文；向量在返回前统一做 L2 归一化，
 * 使检索层可以用点积之外的余弦语义直接比较。
 */
export class OpenAiCompatibleEmbeddingProvider implements EmbeddingProvider {
  readonly name = "openai";
  readonly model: string;

  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly costPerMillionTokens?: { input?: number };
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: OpenAiCompatibleEmbeddingProviderOptions) {
    this.model = options.model;
    this.baseUrl = (options.baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxRetries = options.maxRetries ?? 1;
    if (options.costPerMillionTokens !== undefined) this.costPerMillionTokens = options.costPerMillionTokens;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => Date.now());
    this.sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async embed(request: EmbeddingRequest): Promise<EmbeddingResult> {
    if (request.texts.length === 0) {
      return { vectors: [], model: this.model, latencyMs: 0, attempts: 1 };
    }
    const startedAt = this.now();
    let attempt = 0;
    // 最多重试 maxRetries 次：可重试错误退避后重试，其余直接抛出
    for (;;) {
      attempt += 1;
      try {
        return await this.embedOnce(request, startedAt, attempt);
      } catch (error) {
        const retryable = error instanceof LlmProviderError && error.retryable && RETRYABLE_KINDS.has(error.kind);
        if (!retryable || attempt > this.maxRetries) throw error;
        await this.sleep(RETRY_BACKOFF_MS);
      }
    }
  }

  private async embedOnce(request: EmbeddingRequest, startedAt: number, attempt: number): Promise<EmbeddingResult> {
    const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
    const signal = request.signal ? AbortSignal.any([request.signal, timeoutSignal]) : timeoutSignal;
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/embeddings`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({ model: this.model, input: request.texts }),
        signal,
      });
    } catch (error) {
      if (request.signal?.aborted) {
        throw new LlmProviderError("canceled", "Embedding 调用已被取消", { cause: error });
      }
      if (error instanceof DOMException && error.name === "TimeoutError") {
        throw new LlmProviderError("timeout", "Embedding 调用超时", { cause: error });
      }
      if (error instanceof TypeError) {
        // undici fetch 的网络层失败统一抛 TypeError
        throw new LlmProviderError("network", "无法连接 Embedding 服务", { cause: error });
      }
      throw error;
    }

    if (!response.ok) {
      // 有意不读取响应体：错误消息保持稳定模板，避免正文进入日志
      const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
      throw llmErrorForHttpStatus(response.status, retryAfterMs !== undefined ? { retryAfterMs } : {});
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      // 响应体读取期间超时：归为 timeout（可重试），不能误判为不可重试的响应结构错误
      if (timeoutSignal.aborted) {
        throw new LlmProviderError("timeout", "Embedding 调用超时", { cause: error });
      }
      throw new LlmProviderError("invalid_response", "Embedding 响应体不是合法 JSON", { cause: error });
    }

    const raw = (payload as { data?: unknown }).data;
    if (!Array.isArray(raw) || raw.length !== request.texts.length) {
      throw new LlmProviderError("invalid_response", "Embedding 响应缺少与输入等量的向量");
    }
    const byIndex = new Map<number, number[]>();
    let dimensions = 0;
    for (const item of raw) {
      const index = (item as { index?: unknown }).index;
      const embedding = (item as { embedding?: unknown }).embedding;
      if (typeof index !== "number" || !Array.isArray(embedding) || embedding.length === 0
        || !embedding.every((value) => typeof value === "number" && Number.isFinite(value))) {
        throw new LlmProviderError("invalid_response", "Embedding 响应包含非法向量");
      }
      if (dimensions === 0) dimensions = embedding.length;
      else if (dimensions !== embedding.length) {
        throw new LlmProviderError("invalid_response", "Embedding 响应向量维度不一致");
      }
      byIndex.set(index, embedding as number[]);
    }
    if (byIndex.size !== request.texts.length) {
      throw new LlmProviderError("invalid_response", "Embedding 响应向量索引不完整");
    }

    const vectors = [...byIndex.keys()].sort((a, b) => a - b).map((index) => {
      const vector = byIndex.get(index)!;
      return normalize(vector);
    });
    const usage = this.usageFrom(payload);
    return {
      vectors,
      model: this.reportedModel(payload),
      ...(usage === undefined ? {} : { usage }),
      latencyMs: Math.max(0, this.now() - startedAt),
      attempts: attempt,
    };
  }

  private reportedModel(payload: unknown): string {
    const reported = (payload as { model?: unknown }).model;
    return typeof reported === "string" && reported ? reported : this.model;
  }

  private usageFrom(payload: unknown): EmbeddingResult["usage"] {
    const raw = (payload as { usage?: { prompt_tokens?: unknown; total_tokens?: unknown } }).usage;
    const usage: NonNullable<EmbeddingResult["usage"]> = {};
    if (typeof raw?.total_tokens === "number") usage.totalTokens = raw.total_tokens;
    else if (typeof raw?.prompt_tokens === "number") usage.totalTokens = raw.prompt_tokens;
    const inputCost = this.costPerMillionTokens?.input;
    if (inputCost !== undefined && usage.totalTokens !== undefined) {
      usage.costUsd = Math.round(((usage.totalTokens / 1_000_000) * inputCost) * 1e6) / 1e6;
    }
    return usage;
  }
}

/** L2 归一化；零向量原样返回（余弦按 0 处理）。 */
function normalize(vector: number[]): number[] {
  let sum = 0;
  for (const value of vector) sum += value * value;
  const norm = Math.sqrt(sum);
  if (norm === 0 || !Number.isFinite(norm)) return vector.slice();
  return vector.map((value) => value / norm);
}

/** 解析 Retry-After 响应头：只支持秒数（含小数）。 */
function parseRetryAfterMs(raw: string | null): number | undefined {
  if (!raw) return undefined;
  const seconds = Number(raw.trim());
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  return Math.round(seconds * 1_000);
}
