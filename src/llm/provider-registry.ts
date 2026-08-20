import { LlmProviderError } from "../errors.js";
import { MockLlmProvider, type MockLlmStep } from "./mock-provider.js";
import { withLlmResilience, type LlmMetricsRecorder, type LlmSleep } from "./provider.js";
import { OpenAiCompatibleProvider } from "./providers/openai-provider.js";
import type { LlmProviderConfig } from "./model-config.js";
import type { LlmProvider } from "./types.js";

/**
 * 创建 Provider 时的可注入依赖。
 * env 用于读取密钥；fetchImpl/now/sleep/metrics 用于测试与离线评测的确定性注入。
 */
export interface LlmProviderDeps {
  /** 密钥等环境值来源，默认 process.env；密钥只在此处被读取，不进入任何返回值。 */
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: LlmSleep;
  metrics?: LlmMetricsRecorder;
  /** 注入 Mock Provider 的行为脚本（测试/评测用）。 */
  mockSteps?: readonly MockLlmStep[];
}

export type LlmProviderFactory = (config: LlmProviderConfig, deps: LlmProviderDeps) => LlmProvider;

const factories = new Map<string, LlmProviderFactory>();

/**
 * 注册 Provider 工厂；同名注册会覆盖内置实现。
 * 领域服务只依赖 LlmProvider 接口与本注册表，不 import 任何厂商 SDK。
 */
export function registerLlmProviderFactory(name: string, factory: LlmProviderFactory): void {
  factories.set(name, factory);
}

/** 按配置创建已注册的 Provider（含超时/重试韧性装饰）。 */
export function createLlmProvider(config: LlmProviderConfig, deps: LlmProviderDeps = {}): LlmProvider {
  const factory = factories.get(config.provider);
  if (!factory) {
    throw new LlmProviderError(
      "config",
      `未注册的 LLM Provider：${config.provider}；已注册：${[...factories.keys()].join(", ")}`,
    );
  }
  return factory(config, deps);
}

registerLlmProviderFactory("mock", (config, deps) =>
  withLlmResilience(
    new MockLlmProvider({
      model: config.model,
      ...(deps.mockSteps !== undefined ? { steps: deps.mockSteps } : {}),
      ...(deps.sleep !== undefined ? { sleep: deps.sleep } : {}),
      ...(deps.now !== undefined ? { now: deps.now } : {}),
    }),
    {
      ...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
      ...(config.maxRetries !== undefined ? { maxRetries: config.maxRetries } : {}),
      ...(deps.now !== undefined ? { now: deps.now } : {}),
      ...(deps.sleep !== undefined ? { sleep: deps.sleep } : {}),
      ...(deps.metrics !== undefined ? { metrics: deps.metrics } : {}),
      model: config.model,
    },
  ),
);

registerLlmProviderFactory("openai", (config, deps) => {
  const environment = deps.env ?? process.env;
  const apiKeyEnv = config.apiKeyEnv ?? "OPENAI_API_KEY";
  const apiKey = environment[apiKeyEnv]?.trim() ?? "";
  if (!apiKey) {
    throw new LlmProviderError("auth", `环境变量 ${apiKeyEnv} 未设置模型密钥，无法创建 openai Provider`);
  }
  return withLlmResilience(
    new OpenAiCompatibleProvider({
      model: config.model,
      ...(config.baseUrl !== undefined ? { baseUrl: config.baseUrl } : {}),
      apiKey,
      ...(config.responseMode !== undefined ? { responseMode: config.responseMode } : {}),
      ...(config.temperature !== undefined ? { temperature: config.temperature } : {}),
      ...(config.maxOutputTokens !== undefined ? { maxOutputTokens: config.maxOutputTokens } : {}),
      ...(config.costPerMillionTokens !== undefined ? { costPerMillionTokens: config.costPerMillionTokens } : {}),
      ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
    }),
    {
      ...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
      ...(config.maxRetries !== undefined ? { maxRetries: config.maxRetries } : {}),
      ...(deps.now !== undefined ? { now: deps.now } : {}),
      ...(deps.sleep !== undefined ? { sleep: deps.sleep } : {}),
      ...(deps.metrics !== undefined ? { metrics: deps.metrics } : {}),
      model: config.model,
    },
  );
});
