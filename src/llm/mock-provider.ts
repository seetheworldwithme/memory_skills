import { LlmProviderError } from "../errors.js";
import { llmErrorForHttpStatus, realLlmSleep, type LlmSleep } from "./provider.js";
import type { LlmProvider, LlmStructuredRequest, LlmStructuredResponse, LlmUsage } from "./types.js";

/**
 * Mock Provider 的可脚本化行为步骤。
 * 语义与真实 Provider 对齐：http-error 复用统一的 HTTP 状态映射，
 * 因此契约测试可以用同一组步骤驱动 Mock 与真实 Provider。
 */
export type MockLlmStep =
  | { type: "ok"; data: unknown; usage?: Partial<LlmUsage>; latencyMs?: number }
  | { type: "http-error"; status: number; retryAfterMs?: number; latencyMs?: number }
  | { type: "invalid-json"; text?: string; usage?: Partial<LlmUsage>; latencyMs?: number }
  | { type: "schema-mismatch"; data: unknown; usage?: Partial<LlmUsage>; latencyMs?: number }
  | { type: "network-error"; latencyMs?: number };

export interface MockLlmProviderOptions {
  /** 行为脚本：每次尝试消费一步，用尽后重复最后一步。 */
  steps?: readonly MockLlmStep[];
  model?: string;
  sleep?: LlmSleep;
  now?: () => number;
}

/**
 * 确定性 Mock Provider：
 * - 用于单元测试与离线评测（Sprint 5 提案流水线将复用它保证可复现）；
 * - 记录收到的请求供调用方断言"输入只含任务、允许内容与 Schema"；
 * - 它与真实 Provider 走完全相同的错误映射与取消语义。
 */
export class MockLlmProvider implements LlmProvider {
  readonly name = "mock";

  private readonly steps: readonly MockLlmStep[];
  private readonly model: string;
  private readonly sleepImpl: LlmSleep;
  private readonly now: () => number;
  private cursor = 0;

  constructor(options: MockLlmProviderOptions = {}) {
    this.steps = options.steps ?? [{ type: "ok", data: {} }];
    this.model = options.model ?? "mock-model";
    this.sleepImpl = options.sleep ?? realLlmSleep;
    this.now = options.now ?? Date.now;
  }

  /** 收到的请求快照（含正文），仅供测试断言使用，不进入指标。 */
  readonly receivedRequests: {
    task: string;
    systemPrompt: string;
    userContent: string;
    schemaName: string;
  }[] = [];

  async structured<T>(request: LlmStructuredRequest<T>): Promise<LlmStructuredResponse<T>> {
    this.receivedRequests.push({
      task: request.task,
      systemPrompt: request.systemPrompt,
      userContent: request.userContent,
      schemaName: request.schemaName,
    });
    const step = this.steps[Math.min(this.cursor, this.steps.length - 1)]!;
    this.cursor += 1;

    const startedAt = this.now();
    const latencyMs = stepLatencyMs(step);
    if (latencyMs > 0) await this.sleepImpl(latencyMs, request.signal);
    if (request.signal?.aborted) {
      throw new LlmProviderError("canceled", "Mock 模型调用已被取消");
    }

    switch (step.type) {
      case "ok": {
        // Mock 信任脚本数据，但仍执行 Schema 校验，保持与真实 Provider 一致的输出契约
        const data = request.schema.parse(step.data);
        return {
          data,
          model: this.model,
          usage: normalizeUsage(step.usage),
          finishReason: "stop",
          attempts: 1,
          latencyMs: this.now() - startedAt,
        };
      }
      case "http-error":
        throw llmErrorForHttpStatus(step.status, step.retryAfterMs !== undefined ? { retryAfterMs: step.retryAfterMs } : {});
      case "invalid-json":
        // 模拟真实 Provider：模型返回了 200 但正文不是合法 JSON
        throw new LlmProviderError("invalid_response", "模型响应不是合法 JSON");
      case "schema-mismatch": {
        const result = request.schema.safeParse(step.data);
        if (result.success) {
          throw new Error("mock schema-mismatch 步骤的数据意外通过了校验，请修正测试脚本");
        }
        throw new LlmProviderError("invalid_response", "模型输出未通过结构校验");
      }
      case "network-error":
        throw new LlmProviderError("network", "Mock 网络错误");
    }
  }
}

function stepLatencyMs(step: MockLlmStep): number {
  return step.latencyMs ?? 0;
}

/** 合成用量：未指定时给出最小确定值，保证指标字段完整。 */
function normalizeUsage(usage: Partial<LlmUsage> | undefined): LlmUsage {
  const inputTokens = usage?.inputTokens ?? 1;
  const outputTokens = usage?.outputTokens ?? 1;
  return {
    inputTokens,
    outputTokens,
    totalTokens: usage?.totalTokens ?? inputTokens + outputTokens,
    ...(usage?.costUsd !== undefined ? { costUsd: usage.costUsd } : {}),
  };
}
