import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";

import { LlmProviderError } from "../src/errors.js";
import { describeLlmConfig, resolveLlmConfigFromEnv } from "../src/llm/model-config.js";
import { MockLlmProvider, type MockLlmStep } from "../src/llm/mock-provider.js";
import { InMemoryLlmMetricsRecorder, withLlmResilience } from "../src/llm/provider.js";
import { createLlmProvider, registerLlmProviderFactory } from "../src/llm/provider-registry.js";
import type { LlmProvider, LlmStructuredRequest } from "../src/llm/types.js";

const schema = z.object({ items: z.array(z.object({ name: z.string() })) });

// 唯一标记用于验证"指标与错误消息绝不携带 Prompt/Response 正文"
const contentMarker = "UNIT-CONTENT-MARKER-5f2a";

function makeRequest(overrides: Partial<LlmStructuredRequest<z.infer<typeof schema>>> = {}) {
  return {
    task: "unit-test",
    systemPrompt: "从内容中提取条目",
    userContent: `示例证据：${contentMarker}`,
    schemaName: "items",
    schema,
    ...overrides,
  };
}

function resilientMock(steps: readonly MockLlmStep[], options: Parameters<typeof withLlmResilience>[1] = {}) {
  const mock = new MockLlmProvider({ steps });
  return { mock, provider: withLlmResilience(mock, options) };
}

function assertLlmError(error: unknown, kind: string, code: string): boolean {
  assert.ok(error instanceof LlmProviderError, `应为 LlmProviderError，实际：${String(error)}`);
  assert.equal(error.kind, kind);
  assert.equal(error.code, code);
  return true;
}

test("Mock Provider 返回结构化输出并通过 Schema 校验，同时记录请求", async () => {
  const { mock, provider } = resilientMock([
    { type: "ok", data: { items: [{ name: "偏好中文" }] }, usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.001 } },
  ]);

  const response = await provider.structured(makeRequest());

  assert.deepEqual(response.data, { items: [{ name: "偏好中文" }] });
  assert.equal(response.model, "mock-model");
  assert.equal(response.attempts, 1);
  assert.equal(response.finishReason, "stop");
  assert.equal(response.usage.inputTokens, 10);
  assert.equal(response.usage.totalTokens, 15);
  assert.equal(response.usage.costUsd, 0.001);
  assert.ok(response.latencyMs >= 0);

  // 输入只包含任务、允许内容与结构名，Mock 如实记录
  assert.deepEqual(mock.receivedRequests, [
    { task: "unit-test", systemPrompt: "从内容中提取条目", userContent: `示例证据：${contentMarker}`, schemaName: "items" },
  ]);
});

test("非法 JSON 响应映射为 invalid_response 且不重试", async () => {
  const { mock, provider } = resilientMock([{ type: "invalid-json" }], { maxRetries: 3, sleep: async () => {} });

  await assert.rejects(
    () => provider.structured(makeRequest()),
    (error) => assertLlmError(error, "invalid_response", "LLM_INVALID_RESPONSE") && !(error as LlmProviderError).retryable,
  );
  assert.equal(mock.receivedRequests.length, 1);
});

test("Schema 不匹配映射为 invalid_response 且不重试", async () => {
  const { mock, provider } = resilientMock([{ type: "schema-mismatch", data: { wrong: true } }], {
    maxRetries: 2,
    sleep: async () => {},
  });

  await assert.rejects(
    () => provider.structured(makeRequest()),
    (error) => assertLlmError(error, "invalid_response", "LLM_INVALID_RESPONSE"),
  );
  assert.equal(mock.receivedRequests.length, 1);
});

test("单次尝试超时映射为 timeout，下次尝试成功后正常返回", async () => {
  const { provider } = resilientMock(
    [{ type: "ok", data: { items: [] }, latencyMs: 5_000 }],
    { timeoutMs: 40, maxRetries: 0 },
  );
  await assert.rejects(
    () => provider.structured(makeRequest()),
    (error) => assertLlmError(error, "timeout", "LLM_TIMEOUT"),
  );

  const retrying = resilientMock(
    [{ type: "ok", data: { items: [] }, latencyMs: 5_000 }, { type: "ok", data: { items: [{ name: "b" }] } }],
    { timeoutMs: 40, maxRetries: 1 },
  );
  const response = await retrying.provider.structured(makeRequest());
  assert.equal(response.attempts, 2);
  assert.deepEqual(response.data, { items: [{ name: "b" }] });
});

test("发起前取消：请求不触达模型，错误为 canceled 且不重试", async () => {
  const { mock, provider } = resilientMock([{ type: "ok", data: { items: [] } }], { maxRetries: 2 });
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    () => provider.structured(makeRequest({ signal: controller.signal })),
    (error) => assertLlmError(error, "canceled", "LLM_CANCELED"),
  );
  assert.equal(mock.receivedRequests.length, 0);
});

test("重试等待期间取消：立即以 canceled 失败", async () => {
  const { provider } = resilientMock([{ type: "http-error", status: 429 }], {
    maxRetries: 2,
    baseDelayMs: 10_000,
  });
  const controller = new AbortController();
  const call = provider.structured(makeRequest({ signal: controller.signal }));
  const abortTimer = setTimeout(() => controller.abort(), 20);

  try {
    await assert.rejects(
      () => call,
      (error) => assertLlmError(error, "canceled", "LLM_CANCELED"),
    );
  } finally {
    clearTimeout(abortTimer);
  }
});

test("限流按退避重试：优先 Retry-After，其后指数退避", async () => {
  const delays: number[] = [];
  const { provider } = resilientMock(
    [
      { type: "http-error", status: 429, retryAfterMs: 250 },
      { type: "http-error", status: 429 },
      { type: "ok", data: { items: [] } },
    ],
    { maxRetries: 2, baseDelayMs: 100, sleep: async (ms) => { delays.push(ms); } },
  );

  const response = await provider.structured(makeRequest());
  assert.equal(response.attempts, 3);
  assert.deepEqual(delays, [250, 200]);
});

test("可重试错误耗尽重试次数后抛出最后一次错误", async () => {
  const { mock, provider } = resilientMock(
    [{ type: "http-error", status: 429 }, { type: "http-error", status: 429 }, { type: "http-error", status: 429 }],
    { maxRetries: 2, sleep: async () => {} },
  );

  await assert.rejects(
    () => provider.structured(makeRequest()),
    (error) => assertLlmError(error, "rate_limited", "LLM_RATE_LIMITED"),
  );
  assert.equal(mock.receivedRequests.length, 3);
});

test("鉴权失败等不可重试错误立即抛出", async () => {
  const { mock, provider } = resilientMock([{ type: "http-error", status: 401 }], {
    maxRetries: 2,
    sleep: async () => {},
  });

  await assert.rejects(
    () => provider.structured(makeRequest()),
    (error) => assertLlmError(error, "auth", "LLM_AUTH_ERROR"),
  );
  assert.equal(mock.receivedRequests.length, 1);
});

test("未分类异常包装为 unknown 且不重试", async () => {
  class ExplodingProvider implements LlmProvider {
    readonly name = "exploding";
    async structured(): Promise<never> {
      throw new Error("boom");
    }
  }

  await assert.rejects(
    () => withLlmResilience(new ExplodingProvider(), { sleep: async () => {} }).structured(makeRequest()),
    (error) => assertLlmError(error, "unknown", "LLM_UNEXPECTED"),
  );
});

test("指标记录调用、失败、重试、Token 与成本，且不含正文", async () => {
  const metrics = new InMemoryLlmMetricsRecorder();
  const okProvider = withLlmResilience(
    new MockLlmProvider({ steps: [{ type: "ok", data: { items: [] }, usage: { inputTokens: 100, outputTokens: 50, costUsd: 0.002 } }] }),
    { metrics, model: "mock-model" },
  );
  const retryProvider = withLlmResilience(
    new MockLlmProvider({ steps: [{ type: "http-error", status: 500 }, { type: "ok", data: { items: [] }, usage: { inputTokens: 10, outputTokens: 5 } }] }),
    { metrics, model: "mock-model", sleep: async () => {} },
  );

  await okProvider.structured(makeRequest());
  const response = await retryProvider.structured(makeRequest());
  assert.equal(response.attempts, 2);

  const summary = metrics.summary();
  assert.equal(summary.calls, 2);
  assert.equal(summary.failures, 1);
  assert.equal(summary.retries, 1);
  assert.equal(summary.inputTokens, 110);
  assert.equal(summary.outputTokens, 55);
  assert.equal(summary.costUsd, 0.002);
  assert.ok(summary.p50LatencyMs >= 0);
  assert.ok(summary.p95LatencyMs >= summary.p50LatencyMs);

  // 结构性保证：指标序列化结果不含任何正文标记
  assert.ok(!JSON.stringify(metrics.records).includes(contentMarker));
  assert.ok(!JSON.stringify(summary).includes(contentMarker));
});

test("resolveLlmConfigFromEnv 默认使用 mock，自定义环境变量全部生效", () => {
  assert.deepEqual(resolveLlmConfigFromEnv({}), { provider: "mock", model: "mock-model" });

  const config = resolveLlmConfigFromEnv({
    MEMORY_SKILLS_LLM_PROVIDER: "openai",
    MEMORY_SKILLS_LLM_MODEL: "gpt-4o-mini",
    MEMORY_SKILLS_LLM_BASE_URL: "https://open.bigmodel.cn/api/paas/v4",
    MEMORY_SKILLS_LLM_TIMEOUT_MS: "15000",
    MEMORY_SKILLS_LLM_MAX_RETRIES: "4",
    MEMORY_SKILLS_LLM_API_KEY_ENV: "MY_MODEL_KEY",
    MEMORY_SKILLS_LLM_RESPONSE_MODE: "json_schema",
    MEMORY_SKILLS_LLM_TEMPERATURE: "0.2",
    MEMORY_SKILLS_LLM_MAX_OUTPUT_TOKENS: "2048",
    MEMORY_SKILLS_LLM_COST_INPUT_PER_MTOK: "0.15",
    MEMORY_SKILLS_LLM_COST_OUTPUT_PER_MTOK: "0.6",
  });
  assert.deepEqual(config, {
    provider: "openai",
    model: "gpt-4o-mini",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    timeoutMs: 15_000,
    maxRetries: 4,
    apiKeyEnv: "MY_MODEL_KEY",
    responseMode: "json_schema",
    temperature: 0.2,
    maxOutputTokens: 2_048,
    costPerMillionTokens: { input: 0.15, output: 0.6 },
  });
});

test("配置解析对非法输入给出稳定的 config 错误", () => {
  assert.throws(
    () => resolveLlmConfigFromEnv({ MEMORY_SKILLS_LLM_PROVIDER: "openai" }),
    (error) => assertLlmError(error, "config", "LLM_CONFIG_ERROR"),
  );
  assert.throws(
    () => resolveLlmConfigFromEnv({ MEMORY_SKILLS_LLM_TIMEOUT_MS: "-3" }),
    /MEMORY_SKILLS_LLM_TIMEOUT_MS/,
  );
  assert.throws(
    () => resolveLlmConfigFromEnv({ MEMORY_SKILLS_LLM_RESPONSE_MODE: "yaml" }),
    /MEMORY_SKILLS_LLM_RESPONSE_MODE/,
  );
});

test("配置对象与日志描述只含密钥变量名，绝不含密钥值", () => {
  const secretValue = "sk-unit-secret-9911";
  const config = resolveLlmConfigFromEnv({
    MEMORY_SKILLS_LLM_PROVIDER: "openai",
    MEMORY_SKILLS_LLM_MODEL: "gpt-4o-mini",
    MEMORY_SKILLS_LLM_API_KEY_ENV: "MY_MODEL_KEY",
    MY_MODEL_KEY: secretValue,
    OPENAI_API_KEY: secretValue,
  });

  const serialized = `${JSON.stringify(config)}${JSON.stringify(describeLlmConfig(config))}`;
  assert.ok(serialized.includes("MY_MODEL_KEY"));
  assert.ok(!serialized.includes(secretValue));
});

test("Registry 按配置创建 Provider 并附加韧性装饰", async () => {
  const metrics = new InMemoryLlmMetricsRecorder();
  const provider = createLlmProvider({ provider: "mock", model: "mock-model" }, {
    mockSteps: [
      { type: "http-error", status: 429 },
      { type: "ok", data: { items: [{ name: "中文偏好" }] } },
    ],
    metrics,
    sleep: async () => {},
  });
  assert.equal(provider.name, "mock");

  const response = await provider.structured(makeRequest());
  assert.deepEqual(response.data, { items: [{ name: "中文偏好" }] });
  assert.equal(response.attempts, 2);
  assert.equal(metrics.summary().retries, 1);
});

test("Registry 对未注册的 Provider 与缺失密钥给出 config/auth 错误", () => {
  assert.throws(
    () => createLlmProvider({ provider: "nope", model: "x" }),
    (error) => assertLlmError(error, "config", "LLM_CONFIG_ERROR"),
  );
  assert.throws(
    () => createLlmProvider({ provider: "openai", model: "gpt-4o-mini" }, { env: {} }),
    (error) => assertLlmError(error, "auth", "LLM_AUTH_ERROR"),
  );
});

test("Registry 支持注册自定义 Provider 工厂", () => {
  class ProbeProvider implements LlmProvider {
    readonly name = "probe";
    readonly receivedModel: string;
    constructor(model: string) {
      this.receivedModel = model;
    }
    async structured<T>(): Promise<import("../src/llm/types.js").LlmStructuredResponse<T>> {
      throw new Error("probe 不参与调用");
    }
  }
  registerLlmProviderFactory("unit-probe", (config) => new ProbeProvider(config.model));

  const provider = createLlmProvider({ provider: "unit-probe", model: "probe-model" }) as ProbeProvider;
  assert.ok(provider instanceof ProbeProvider);
  assert.equal(provider.receivedModel, "probe-model");
});

test("Registry 组装的 openai Provider 从环境读取密钥并走注入的 fetch", async () => {
  const fetchImpl = (async () => new Response(
    JSON.stringify({
      model: "gpt-4o-mini",
      choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify({ items: [] }) }, finish_reason: "stop" }],
      usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  )) as typeof fetch;

  const provider = createLlmProvider(
    { provider: "openai", model: "gpt-4o-mini", baseUrl: "http://127.0.0.1:9/v1", responseMode: "json_object" },
    { env: { OPENAI_API_KEY: "k" }, fetchImpl, sleep: async () => {} },
  );

  const response = await provider.structured(makeRequest());
  assert.deepEqual(response.data, { items: [] });
  assert.equal(response.usage.totalTokens, 7);
  assert.equal(response.attempts, 1);
});
