import { LlmProviderError } from "../errors.js";
import { MockEmbeddingProvider } from "./mock-embedding-provider.js";
import { OpenAiCompatibleEmbeddingProvider } from "./providers/openai-embedding-provider.js";
import type { EmbeddingProvider } from "./types.js";

/**
 * Embedding Provider 配置。
 * 安全约束与 LLM 配置一致：只引用密钥环境变量名（apiKeyEnv），不含密钥值；
 * 密钥只在创建 Provider 时从环境读取，不进入任何返回值、日志或指标。
 */
export interface EmbeddingProviderConfig {
  /** Provider 名称，需已注册：mock（默认）/ openai / 自定义注册名。 */
  provider: string;
  model: string;
  /** 兼容端点地址；OpenAI 兼容实现默认 https://api.openai.com/v1。 */
  baseUrl?: string;
  /** 单次尝试超时毫秒数，默认 30000。 */
  timeoutMs?: number;
  /** 额外重试次数，默认 1；重试间固定退避 200ms。 */
  maxRetries?: number;
  /** 密钥所在环境变量名（引用，不是密钥本身）。 */
  apiKeyEnv?: string;
  /** 批量嵌入上限，默认 16；超过时由调用方分批。 */
  batchSize?: number;
  /** 可选单价（每百万 Token，美元），用于折算成本指标。 */
  costPerMillionTokens?: { input?: number };
}

type Environment = Record<string, string | undefined>;

/**
 * 从环境变量解析 Embedding 配置：
 * - MEMORY_SKILLS_EMBEDDING_PROVIDER：mock（默认）/ openai / 已注册的其它名称；
 * - MEMORY_SKILLS_EMBEDDING_MODEL：模型名，非 mock Provider 必填，作为向量索引版本键；
 * - MEMORY_SKILLS_EMBEDDING_BASE_URL / _TIMEOUT_MS / _MAX_RETRIES / _BATCH_SIZE；
 * - MEMORY_SKILLS_EMBEDDING_API_KEY_ENV：密钥环境变量名，openai 默认 OPENAI_API_KEY；
 * - MEMORY_SKILLS_EMBEDDING_COST_PER_MTOK：可选成本单价（按输入 Token 计）。
 */
export function resolveEmbeddingConfigFromEnv(environment: Environment = process.env): EmbeddingProviderConfig {
  const provider = environment.MEMORY_SKILLS_EMBEDDING_PROVIDER?.trim().toLowerCase() || "mock";

  let model = environment.MEMORY_SKILLS_EMBEDDING_MODEL?.trim() ?? "";
  if (!model) {
    if (provider === "mock") model = "mock-embedding";
    else throw new LlmProviderError("config", `使用 Embedding Provider "${provider}" 时必须设置 MEMORY_SKILLS_EMBEDDING_MODEL`);
  }

  const config: EmbeddingProviderConfig = { provider, model };

  const baseUrl = environment.MEMORY_SKILLS_EMBEDDING_BASE_URL?.trim();
  if (baseUrl) config.baseUrl = baseUrl;

  const timeoutMs = optionalPositiveInt(environment.MEMORY_SKILLS_EMBEDDING_TIMEOUT_MS, "MEMORY_SKILLS_EMBEDDING_TIMEOUT_MS");
  if (timeoutMs !== undefined) config.timeoutMs = timeoutMs;

  const maxRetries = optionalNonNegativeInt(environment.MEMORY_SKILLS_EMBEDDING_MAX_RETRIES, "MEMORY_SKILLS_EMBEDDING_MAX_RETRIES");
  if (maxRetries !== undefined) config.maxRetries = maxRetries;

  const batchSize = optionalPositiveInt(environment.MEMORY_SKILLS_EMBEDDING_BATCH_SIZE, "MEMORY_SKILLS_EMBEDDING_BATCH_SIZE");
  if (batchSize !== undefined) config.batchSize = batchSize;

  const apiKeyEnv = environment.MEMORY_SKILLS_EMBEDDING_API_KEY_ENV?.trim();
  if (apiKeyEnv) config.apiKeyEnv = apiKeyEnv;
  else if (provider === "openai") config.apiKeyEnv = "OPENAI_API_KEY";

  const inputCost = optionalNonNegativeNumber(environment.MEMORY_SKILLS_EMBEDDING_COST_PER_MTOK, "MEMORY_SKILLS_EMBEDDING_COST_PER_MTOK");
  if (inputCost !== undefined) config.costPerMillionTokens = { input: inputCost };

  return config;
}

/** 供日志与文档使用的安全配置描述：显式投影全部字段，证明不含密钥值。 */
export function describeEmbeddingConfig(config: EmbeddingProviderConfig): Record<string, unknown> {
  return {
    provider: config.provider,
    model: config.model,
    baseUrl: config.baseUrl ?? null,
    timeoutMs: config.timeoutMs ?? null,
    maxRetries: config.maxRetries ?? null,
    apiKeyEnv: config.apiKeyEnv ?? null,
    batchSize: config.batchSize ?? null,
    costPerMillionTokens: config.costPerMillionTokens ?? null,
  };
}

/** 创建 Embedding Provider 时的可注入依赖（测试与离线评测用）。 */
export interface EmbeddingProviderDeps {
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export type EmbeddingProviderFactory = (config: EmbeddingProviderConfig, deps: EmbeddingProviderDeps) => EmbeddingProvider;

const factories = new Map<string, EmbeddingProviderFactory>();

/** 注册 Embedding Provider 工厂；同名注册会覆盖内置实现。 */
export function registerEmbeddingProviderFactory(
  name: string,
  factory: EmbeddingProviderFactory,
): void {
  factories.set(name, factory);
}

/** 按配置创建已注册的 Embedding Provider。 */
export function createEmbeddingProvider(
  config: EmbeddingProviderConfig,
  deps: EmbeddingProviderDeps = {},
): EmbeddingProvider {
  const factory = factories.get(config.provider);
  if (!factory) {
    throw new LlmProviderError(
      "config",
      `未注册的 Embedding Provider：${config.provider}；已注册：${[...factories.keys()].join(", ")}`,
    );
  }
  return factory(config, deps);
}

registerEmbeddingProviderFactory("mock", (config) => new MockEmbeddingProvider({ model: config.model }));

registerEmbeddingProviderFactory("openai", (config, deps) => {
  const environment = deps.env ?? process.env;
  const apiKeyEnv = config.apiKeyEnv ?? "OPENAI_API_KEY";
  const apiKey = environment[apiKeyEnv]?.trim() ?? "";
  if (!apiKey) {
    throw new LlmProviderError("auth", `环境变量 ${apiKeyEnv} 未设置模型密钥，无法创建 openai Embedding Provider`);
  }
  return new OpenAiCompatibleEmbeddingProvider({
    model: config.model,
    ...(config.baseUrl !== undefined ? { baseUrl: config.baseUrl } : {}),
    apiKey,
    ...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
    ...(config.maxRetries !== undefined ? { maxRetries: config.maxRetries } : {}),
    ...(config.costPerMillionTokens !== undefined ? { costPerMillionTokens: config.costPerMillionTokens } : {}),
    ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
    ...(deps.now !== undefined ? { now: deps.now } : {}),
    ...(deps.sleep !== undefined ? { sleep: deps.sleep } : {}),
  });
});

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
