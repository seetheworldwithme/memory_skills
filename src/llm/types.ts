import type { ZodType } from "zod";

/**
 * 结构化调用的输入。
 * 刻意只包含任务、允许给模型看的内容与输出结构：
 * Provider 不感知 Scope、数据库与治理概念，调用方负责筛选与脱敏。
 */
export interface LlmStructuredRequest<T> {
  /** 任务标识（如 "memory-proposal"），用于指标统计与 Prompt 版本关联，不发给模型。 */
  task: string;
  /** 任务指令，由调用方（未来的 Prompt Registry）提供，Provider 原样使用。 */
  systemPrompt: string;
  /** 允许模型看到的用户内容：调用方已完成筛选、裁剪与脱敏（如 Evidence 文本）。 */
  userContent: string;
  /** 输出结构名，供需要命名 Schema 的供应商使用。 */
  schemaName: string;
  /** 输出结构校验；转换为供应商格式由 Provider 内部完成，领域服务不感知。 */
  schema: ZodType<T>;
  temperature?: number;
  maxOutputTokens?: number;
  /** 外部取消信号；超时由韧性装饰器统一注入内部信号实现。 */
  signal?: AbortSignal;
}

/** Token 用量与可选成本。字段缺失表示供应商未返回对应数据。 */
export interface LlmUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  /** 按配置单价折算的成本（美元）；未配置单价时省略。 */
  costUsd?: number;
}

/** 结束原因的规范化表示，不泄漏供应商原始字符串。 */
export type LlmFinishReason = "stop" | "length" | "content_filter" | "other";

/** 结构化调用的统一响应：Provider 必须输出项目内部类型。 */
export interface LlmStructuredResponse<T> {
  /** 已通过 Schema 校验的结构化数据。 */
  data: T;
  /** 实际使用的模型名（供应商返回值或本地配置值）。 */
  model: string;
  usage: LlmUsage;
  finishReason?: LlmFinishReason;
  /** 含重试的总尝试次数（未经重试装饰器时为 1）。 */
  attempts: number;
  latencyMs: number;
}

/**
 * 供应商无关的模型 Provider 接口。
 * 实现约束：
 * - 不得持有 Repository、GovernanceService 等任何领域引用；
 * - 不得把厂商 SDK 的类型泄漏到本接口之外；
 * - 默认不保存完整 Prompt/Response 正文。
 */
export interface LlmProvider {
  /** Provider 名称，与配置中的 provider 字段对应。 */
  readonly name: string;
  structured<T>(request: LlmStructuredRequest<T>): Promise<LlmStructuredResponse<T>>;
}
