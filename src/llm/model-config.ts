import { LlmProviderError } from "../errors.js";

/**
 * Provider 配置。
 * 安全约束：配置里只有密钥环境变量名（apiKeyEnv），绝不包含密钥值；
 * 密钥只在 Registry 创建 Provider 时从环境读取，不进入任何返回值、日志或指标。
 */
export interface LlmProviderConfig {
  /** Provider 名称，需已注册：mock / openai / 自定义注册名。 */
  provider: string;
  model: string;
  /** 兼容端点地址；OpenAI 兼容 Provider 默认 https://api.openai.com/v1。 */
  baseUrl?: string;
  /** 单次尝试超时毫秒数，默认 30000。 */
  timeoutMs?: number;
  /** 额外重试次数，默认 2。 */
  maxRetries?: number;
  /** 密钥所在环境变量名（引用，不是密钥本身）。 */
  apiKeyEnv?: string;
  /**
   * 结构化输出模式（OpenAI 兼容 Provider 使用）：
   * - json_object：最大兼容，Schema 写入系统指令，客户端用 Zod 校验兜底（默认）；
   * - json_schema：官方结构化输出，Schema 随 response_format 传递。
   */
  responseMode?: "json_object" | "json_schema";
  temperature?: number;
  maxOutputTokens?: number;
  /** 可选单价（每百万 Token，美元），用于折算成本指标。 */
  costPerMillionTokens?: { input?: number; output?: number };
}

type Environment = Record<string, string | undefined>;

/**
 * 从环境变量解析 Provider 配置：
 * - MEMORY_SKILLS_LLM_PROVIDER：mock（默认）/ openai / 已注册的其它名称；
 * - MEMORY_SKILLS_LLM_MODEL：模型名，非 mock Provider 必填；
 * - MEMORY_SKILLS_LLM_BASE_URL / _TIMEOUT_MS / _MAX_RETRIES / _TEMPERATURE / _MAX_OUTPUT_TOKENS；
 * - MEMORY_SKILLS_LLM_API_KEY_ENV：密钥环境变量名，openai 默认 OPENAI_API_KEY；
 * - MEMORY_SKILLS_LLM_RESPONSE_MODE：json_object（默认）/ json_schema；
 * - MEMORY_SKILLS_LLM_COST_INPUT_PER_MTOK / _OUTPUT_PER_MTOK：可选成本单价。
 */
export function resolveLlmConfigFromEnv(environment: Environment = process.env): LlmProviderConfig {
  const provider = environment.MEMORY_SKILLS_LLM_PROVIDER?.trim().toLowerCase() || "mock";

  let model = environment.MEMORY_SKILLS_LLM_MODEL?.trim() ?? "";
  if (!model) {
    if (provider === "mock") model = "mock-model";
    else throw new LlmProviderError("config", `使用 Provider "${provider}" 时必须设置 MEMORY_SKILLS_LLM_MODEL`);
  }

  const config: LlmProviderConfig = { provider, model };

  const baseUrl = environment.MEMORY_SKILLS_LLM_BASE_URL?.trim();
  if (baseUrl) config.baseUrl = baseUrl;

  const timeoutMs = optionalPositiveInt(environment.MEMORY_SKILLS_LLM_TIMEOUT_MS, "MEMORY_SKILLS_LLM_TIMEOUT_MS");
  if (timeoutMs !== undefined) config.timeoutMs = timeoutMs;

  const maxRetries = optionalNonNegativeInt(environment.MEMORY_SKILLS_LLM_MAX_RETRIES, "MEMORY_SKILLS_LLM_MAX_RETRIES");
  if (maxRetries !== undefined) config.maxRetries = maxRetries;

  const apiKeyEnv = environment.MEMORY_SKILLS_LLM_API_KEY_ENV?.trim();
  if (apiKeyEnv) config.apiKeyEnv = apiKeyEnv;
  else if (provider === "openai") config.apiKeyEnv = "OPENAI_API_KEY";

  const responseMode = environment.MEMORY_SKILLS_LLM_RESPONSE_MODE?.trim().toLowerCase();
  if (responseMode) {
    if (responseMode !== "json_object" && responseMode !== "json_schema") {
      throw new LlmProviderError(
        "config",
        `MEMORY_SKILLS_LLM_RESPONSE_MODE 必须是 json_object 或 json_schema，收到：${responseMode}`,
      );
    }
    config.responseMode = responseMode;
  }

  const temperature = optionalNonNegativeNumber(environment.MEMORY_SKILLS_LLM_TEMPERATURE, "MEMORY_SKILLS_LLM_TEMPERATURE");
  if (temperature !== undefined) config.temperature = temperature;

  const maxOutputTokens = optionalPositiveInt(environment.MEMORY_SKILLS_LLM_MAX_OUTPUT_TOKENS, "MEMORY_SKILLS_LLM_MAX_OUTPUT_TOKENS");
  if (maxOutputTokens !== undefined) config.maxOutputTokens = maxOutputTokens;

  const inputCost = optionalNonNegativeNumber(environment.MEMORY_SKILLS_LLM_COST_INPUT_PER_MTOK, "MEMORY_SKILLS_LLM_COST_INPUT_PER_MTOK");
  const outputCost = optionalNonNegativeNumber(environment.MEMORY_SKILLS_LLM_COST_OUTPUT_PER_MTOK, "MEMORY_SKILLS_LLM_COST_OUTPUT_PER_MTOK");
  if (inputCost !== undefined || outputCost !== undefined) {
    config.costPerMillionTokens = {
      ...(inputCost !== undefined ? { input: inputCost } : {}),
      ...(outputCost !== undefined ? { output: outputCost } : {}),
    };
  }

  return config;
}

/**
 * 供日志与文档使用的安全配置描述。
 * 显式投影全部字段以证明配置对象不含密钥值；密钥只存在于环境变量中。
 */
export function describeLlmConfig(config: LlmProviderConfig): Record<string, unknown> {
  return {
    provider: config.provider,
    model: config.model,
    ...(config.baseUrl !== undefined ? { baseUrl: config.baseUrl } : {}),
    timeoutMs: config.timeoutMs,
    maxRetries: config.maxRetries,
    apiKeyEnv: config.apiKeyEnv ?? null,
    responseMode: config.responseMode ?? null,
    temperature: config.temperature ?? null,
    maxOutputTokens: config.maxOutputTokens ?? null,
    costPerMillionTokens: config.costPerMillionTokens ?? null,
  };
}

function optionalPositiveInt(raw: string | undefined, name: string): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const value = Number(raw.trim());
  if (!Number.isInteger(value) || value <= 0) {
    throw new LlmProviderError("config", `${name} 必须是正整数，收到：${raw}`);
  }
  return value;
}

function optionalNonNegativeInt(raw: string | undefined, name: string): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const value = Number(raw.trim());
  if (!Number.isInteger(value) || value < 0) {
    throw new LlmProviderError("config", `${name} 必须是非负整数，收到：${raw}`);
  }
  return value;
}

function optionalNonNegativeNumber(raw: string | undefined, name: string): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const value = Number(raw.trim());
  if (!Number.isFinite(value) || value < 0) {
    throw new LlmProviderError("config", `${name} 必须是非负数字，收到：${raw}`);
  }
  return value;
}
