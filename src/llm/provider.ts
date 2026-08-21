import { LlmProviderError, type LlmErrorKind } from "../errors.js";
import type { LlmProvider, LlmStructuredRequest, LlmStructuredResponse, LlmUsage } from "./types.js";

/**
 * 单次尝试的指标记录。
 * 结构上只有计数与数字，不存在 Prompt/Response 正文字段——
 * 这是"默认不保存正文"的结构性保证。
 */
export interface LlmCallMetric {
  provider: string;
  model: string;
  task: string;
  outcome: "success" | "failure";
  /** 失败时的错误分类。 */
  errorKind?: LlmErrorKind;
  /** 第几次尝试，从 1 开始。 */
  attempt: number;
  latencyMs: number;
  usage?: LlmUsage;
}

/** 指标输出接口：通过注入解耦，未来可桥接到事件系统或外部监控。 */
export interface LlmMetricsRecorder {
  record(metric: LlmCallMetric): void;
}

export interface LlmMetricsSummary {
  /** 逻辑调用次数（每次调用至少产生一条 attempt=1 的记录）。 */
  calls: number;
  failures: number;
  /** 额外尝试次数（所有 attempt>1 的记录数）。 */
  retries: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
}

/** 进程内指标收集器：记录请求次数、延迟、Token 与可选成本，不保存正文。 */
export class InMemoryLlmMetricsRecorder implements LlmMetricsRecorder {
  private readonly collected: LlmCallMetric[] = [];

  record(metric: LlmCallMetric): void {
    this.collected.push(metric);
  }

  get records(): readonly LlmCallMetric[] {
    return this.collected;
  }

  summary(): LlmMetricsSummary {
    const latencies = this.collected.map((metric) => metric.latencyMs).sort((a, b) => a - b);
    return {
      calls: this.collected.filter((metric) => metric.attempt === 1).length,
      failures: this.collected.filter((metric) => metric.outcome === "failure").length,
      retries: this.collected.filter((metric) => metric.attempt > 1).length,
      inputTokens: sumUsage(this.collected, "inputTokens"),
      outputTokens: sumUsage(this.collected, "outputTokens"),
      costUsd: round(this.collected.reduce((total, metric) => total + (metric.usage?.costUsd ?? 0), 0)),
      p50LatencyMs: percentile(latencies, 0.5),
      p95LatencyMs: percentile(latencies, 0.95),
    };
  }
}

function sumUsage(metrics: readonly LlmCallMetric[], key: "inputTokens" | "outputTokens"): number {
  return metrics.reduce((total, metric) => total + (metric.usage?.[key] ?? 0), 0);
}

function round(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

function percentile(sortedLatencies: number[], fraction: number): number {
  if (sortedLatencies.length === 0) return 0;
  const index = Math.min(sortedLatencies.length - 1, Math.max(0, Math.ceil(fraction * sortedLatencies.length) - 1));
  return sortedLatencies[index]!;
}

/**
 * 把供应商 HTTP 状态码映射为统一的 Provider 错误。
 * 所有 Provider（含 Mock）都必须复用本函数，保证错误语义跨供应商一致。
 */
export function llmErrorForHttpStatus(
  status: number,
  options: { retryAfterMs?: number } = {},
): LlmProviderError {
  if (status === 401 || status === 403) {
    return new LlmProviderError("auth", `模型服务拒绝鉴权（HTTP ${status}），请检查密钥环境变量`);
  }
  if (status === 408) {
    return new LlmProviderError("timeout", `模型服务报告请求超时（HTTP 408）`);
  }
  if (status === 429) {
    return new LlmProviderError(
      "rate_limited",
      "模型服务限流（HTTP 429）",
      options.retryAfterMs !== undefined ? { retryAfterMs: options.retryAfterMs } : {},
    );
  }
  if (status >= 500) {
    return new LlmProviderError("server_error", `模型服务内部错误（HTTP ${status}）`);
  }
  // 其余 4xx 视为请求构造问题：同样输入重试大概率同样失败
  return new LlmProviderError("invalid_response", `模型服务拒绝了请求（HTTP ${status}）`);
}

/** 可注入的等待函数：支持被取消信号中断，测试中可替换为记录延迟的假实现。 */
export type LlmSleep = (ms: number, signal?: AbortSignal) => Promise<void>;

/** 默认等待实现：被取消时以 canceled 错误拒绝。 */
export function realLlmSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new LlmProviderError("canceled", "重试等待被调用方取消"));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new LlmProviderError("canceled", "重试等待被调用方取消"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** 把任意异常规范为 LlmProviderError；AbortError 归为 canceled，其余归为 unknown（不重试）。 */
export function asLlmProviderError(error: unknown): LlmProviderError {
  if (error instanceof LlmProviderError) return error;
  if (error instanceof Error && error.name === "AbortError") {
    return new LlmProviderError("canceled", "模型调用被中止", { cause: error });
  }
  return new LlmProviderError("unknown", "模型调用出现未分类错误", { cause: error });
}

/** 韧性装饰器选项。 */
export interface LlmResilienceOptions {
  /** 单次尝试超时毫秒数，默认 120000。 */
  timeoutMs?: number;
  /** 额外重试次数（总尝试 = 1 + maxRetries），默认 2。 */
  maxRetries?: number;
  /** 首次重试的基础退避毫秒数，默认 500，之后指数翻倍。 */
  baseDelayMs?: number;
  /** 退避上限毫秒数（含 Retry-After 建议），默认 8000。 */
  maxDelayMs?: number;
  now?: () => number;
  sleep?: LlmSleep;
  metrics?: LlmMetricsRecorder;
  /** 失败指标使用的模型名；成功时以响应内返回的 model 为准。 */
  model?: string;
}

/**
 * 统一的超时与重试装饰器：
 * - 每次尝试注入内部 AbortController，把外部取消与超时计时器都汇入它；
 * - 只有可重试错误（限流、超时、网络、5xx）才按指数退避重试，优先尊重 Retry-After；
 * - 每次尝试（无论成败）都写入指标；成功响应覆盖 attempts 与总延迟。
 */
export function withLlmResilience(inner: LlmProvider, options: LlmResilienceOptions = {}): LlmProvider {
  return new ResilientLlmProvider(inner, options);
}

class ResilientLlmProvider implements LlmProvider {
  readonly name: string;

  constructor(
    private readonly inner: LlmProvider,
    private readonly options: LlmResilienceOptions,
  ) {
    this.name = inner.name;
  }

  async structured<T>(request: LlmStructuredRequest<T>): Promise<LlmStructuredResponse<T>> {
    // 全量捕获后提案证据可达数万字符（约两三万 tokens 输入），中转端点排队加生成
    // 常超 30s；默认放宽到 120s（仍可经 MEMORY_SKILLS_LLM_TIMEOUT_MS 覆盖）
    const timeoutMs = this.options.timeoutMs ?? 120_000;
    const maxRetries = this.options.maxRetries ?? 2;
    const baseDelayMs = this.options.baseDelayMs ?? 500;
    const maxDelayMs = this.options.maxDelayMs ?? 8_000;
    const now = this.options.now ?? Date.now;
    const sleep = this.options.sleep ?? realLlmSleep;
    const metrics = this.options.metrics;
    const callStartedAt = now();
    let attempt = 0;

    for (;;) {
      attempt += 1;
      throwIfCanceledBeforeStart(request.signal);

      // 内部信号：外部取消与超时计时器都会触发它，底层 Provider 只感知一个 signal
      const controller = new AbortController();
      const forwardAbort = () => controller.abort();
      request.signal?.addEventListener("abort", forwardAbort, { once: true });
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const attemptStartedAt = now();
      try {
        const response = await this.inner.structured({ ...request, signal: controller.signal });
        metrics?.record({
          provider: this.inner.name,
          model: response.model,
          task: request.task,
          outcome: "success",
          attempt,
          latencyMs: now() - attemptStartedAt,
          usage: response.usage,
        });
        return { ...response, attempts: attempt, latencyMs: now() - callStartedAt };
      } catch (error) {
        const normalized = asLlmProviderError(error);
        // 归因顺序：外部已取消 -> canceled；内部信号中止但外部未取消 -> timeout
        const finalError = request.signal?.aborted
          ? new LlmProviderError("canceled", "模型调用已被调用方取消")
          : normalized.kind === "canceled"
            ? new LlmProviderError("timeout", `模型调用超过 ${timeoutMs}ms 未返回`)
            : normalized;
        metrics?.record({
          provider: this.inner.name,
          model: this.options.model ?? "unknown",
          task: request.task,
          outcome: "failure",
          errorKind: finalError.kind,
          attempt,
          latencyMs: now() - attemptStartedAt,
        });
        if (!finalError.retryable || attempt > maxRetries) throw finalError;
        const backoff = finalError.retryAfterMs ?? baseDelayMs * 2 ** (attempt - 1);
        await sleep(Math.min(maxDelayMs, backoff), request.signal);
      } finally {
        clearTimeout(timer);
        request.signal?.removeEventListener("abort", forwardAbort);
      }
    }
  }
}

function throwIfCanceledBeforeStart(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new LlmProviderError("canceled", "模型调用在发起前已被调用方取消");
  }
}
