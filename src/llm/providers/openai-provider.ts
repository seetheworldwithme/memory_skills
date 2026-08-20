import { z } from "zod";

import { LlmProviderError } from "../../errors.js";
import { llmErrorForHttpStatus } from "../provider.js";
import type { LlmFinishReason, LlmProvider, LlmStructuredRequest, LlmStructuredResponse, LlmUsage } from "../types.js";

/** OpenAI 兼容端点返回的结束原因到内部规范化值的映射。 */
const FINISH_REASON_MAP: Record<string, LlmFinishReason> = {
  stop: "stop",
  length: "length",
  content_filter: "content_filter",
};

export interface OpenAiCompatibleProviderOptions {
  model: string;
  /** 兼容端点地址，默认 https://api.openai.com/v1；也可指向任何 OpenAI 兼容服务。 */
  baseUrl?: string;
  /** 由 Registry 从环境变量读取后注入；绝不进入日志、指标或错误消息。 */
  apiKey: string;
  /** 结构化输出模式，默认 json_object（最大兼容）。 */
  responseMode?: "json_object" | "json_schema";
  temperature?: number;
  maxOutputTokens?: number;
  /** 可选单价（每百万 Token，美元）。 */
  costPerMillionTokens?: { input?: number; output?: number };
  fetchImpl?: typeof fetch;
}

/**
 * 第一个真实 Provider：走 OpenAI Chat Completions 兼容协议。
 * 实现约束：
 * - 只使用全局 fetch，不依赖任何厂商 SDK，不持有 Repository/GovernanceService 引用；
 * - 输出统一为项目内部类型，供应商响应类型不外泄；
 * - 错误消息保持稳定模板，不拼接响应正文（防止厂商回显用户内容进入日志）。
 */
export class OpenAiCompatibleProvider implements LlmProvider {
  readonly name = "openai";

  private readonly model: string;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly responseMode: "json_object" | "json_schema";
  private readonly temperature?: number;
  private readonly maxOutputTokens?: number;
  private readonly costPerMillionTokens?: { input?: number; output?: number };
  private readonly fetchImpl: typeof fetch;

  constructor(options: OpenAiCompatibleProviderOptions) {
    this.model = options.model;
    this.baseUrl = (options.baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.responseMode = options.responseMode ?? "json_object";
    if (options.temperature !== undefined) this.temperature = options.temperature;
    if (options.maxOutputTokens !== undefined) this.maxOutputTokens = options.maxOutputTokens;
    if (options.costPerMillionTokens !== undefined) this.costPerMillionTokens = options.costPerMillionTokens;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async structured<T>(request: LlmStructuredRequest<T>): Promise<LlmStructuredResponse<T>> {
    const startedAt = Date.now();
    const response = await this.postChatCompletion(request);

    if (!response.ok) {
      // 有意不读取响应体：错误消息保持稳定模板，避免正文中的用户内容或敏感值进入日志
      const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
      throw llmErrorForHttpStatus(response.status, retryAfterMs !== undefined ? { retryAfterMs } : {});
    }

    const payload = await this.readJsonPayload(response, request);
    const choice = (payload as { choices?: unknown[] }).choices?.[0] as
      | { message?: { content?: unknown }; finish_reason?: unknown }
      | undefined;
    const content = choice?.message?.content;
    if (typeof content !== "string" || content.trim() === "") {
      throw new LlmProviderError("invalid_response", "模型响应缺少文本内容");
    }

    const data = this.parseAndValidate(content, request.schema);
    const reportedModel = (payload as { model?: unknown }).model;
    const finishReason = normalizeFinishReason(choice?.finish_reason);
    return {
      data,
      model: typeof reportedModel === "string" && reportedModel ? reportedModel : this.model,
      usage: this.usageFrom(payload),
      attempts: 1,
      latencyMs: Date.now() - startedAt,
      ...(finishReason !== undefined ? { finishReason } : {}),
    };
  }

  private async postChatCompletion<T>(request: LlmStructuredRequest<T>): Promise<Response> {
    try {
      return await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(this.buildRequestBody(request)),
        signal: request.signal ?? null,
      });
    } catch (error) {
      if (request.signal?.aborted) {
        throw new LlmProviderError("canceled", "模型调用已被取消", { cause: error });
      }
      if (error instanceof TypeError) {
        // undici fetch 的网络层失败统一抛 TypeError
        throw new LlmProviderError("network", "无法连接模型服务", { cause: error });
      }
      throw error;
    }
  }

  private buildRequestBody<T>(request: LlmStructuredRequest<T>): Record<string, unknown> {
    const jsonSchema = z.toJSONSchema(request.schema);
    const useNativeSchema = this.responseMode === "json_schema";
    const systemPrompt = useNativeSchema
      ? request.systemPrompt
      : `${request.systemPrompt}\n\n输出要求：只返回一个 JSON 对象，不要输出注释、Markdown 代码块或任何额外文本，结构必须符合以下 JSON Schema：\n${JSON.stringify(jsonSchema)}`;

    const body: Record<string, unknown> = {
      model: this.model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: request.userContent },
      ],
      temperature: request.temperature ?? this.temperature ?? 0,
      response_format: useNativeSchema
        ? { type: "json_schema", json_schema: { name: request.schemaName, schema: jsonSchema, strict: true } }
        : { type: "json_object" },
    };
    const maxOutputTokens = request.maxOutputTokens ?? this.maxOutputTokens;
    if (maxOutputTokens !== undefined) body.max_tokens = maxOutputTokens;
    return body;
  }

  private async readJsonPayload(response: Response, request: LlmStructuredRequest<unknown>): Promise<unknown> {
    try {
      return await response.json();
    } catch (error) {
      if (request.signal?.aborted) {
        throw new LlmProviderError("canceled", "模型调用已被取消", { cause: error });
      }
      throw new LlmProviderError("invalid_response", "模型响应体不是合法 JSON");
    }
  }

  private parseAndValidate<T>(content: string, schema: z.ZodType<T>): T {
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch (error) {
      throw new LlmProviderError("invalid_response", "模型响应不是合法 JSON", { cause: error });
    }
    const result = schema.safeParse(parsed);
    if (!result.success) {
      // 不把校验错误详情放进消息：其中可能包含模型回显的用户内容
      throw new LlmProviderError("invalid_response", "模型输出未通过结构校验", { cause: result.error });
    }
    return result.data;
  }

  private usageFrom(payload: unknown): LlmUsage {
    const raw = (payload as { usage?: { prompt_tokens?: unknown; completion_tokens?: unknown; total_tokens?: unknown } }).usage;
    const usage: LlmUsage = {};
    if (typeof raw?.prompt_tokens === "number") usage.inputTokens = raw.prompt_tokens;
    if (typeof raw?.completion_tokens === "number") usage.outputTokens = raw.completion_tokens;
    if (typeof raw?.total_tokens === "number") usage.totalTokens = raw.total_tokens;
    const cost = this.costUsd(usage);
    if (cost !== undefined) usage.costUsd = cost;
    return usage;
  }

  private costUsd(usage: LlmUsage): number | undefined {
    const { input, output } = this.costPerMillionTokens ?? {};
    if (input === undefined && output === undefined) return undefined;
    const total =
      ((usage.inputTokens ?? 0) / 1_000_000) * (input ?? 0) +
      ((usage.outputTokens ?? 0) / 1_000_000) * (output ?? 0);
    return Math.round(total * 1e6) / 1e6;
  }
}

function normalizeFinishReason(raw: unknown): LlmFinishReason | undefined {
  if (typeof raw !== "string" || raw === "") return undefined;
  return FINISH_REASON_MAP[raw] ?? "other";
}

/** 解析 Retry-After 响应头：只支持秒数（含小数），HTTP 日期格式不解析。 */
function parseRetryAfterMs(raw: string | null): number | undefined {
  if (!raw) return undefined;
  const seconds = Number(raw.trim());
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  return Math.round(seconds * 1_000);
}
