import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";

import { LlmProviderError } from "../src/errors.js";
import { MockLlmProvider, type MockLlmStep } from "../src/llm/mock-provider.js";
import { InMemoryLlmMetricsRecorder, withLlmResilience, type LlmMetricsRecorder, type LlmSleep } from "../src/llm/provider.js";
import { OpenAiCompatibleProvider } from "../src/llm/providers/openai-provider.js";
import type { LlmProvider, LlmStructuredRequest, LlmUsage } from "../src/llm/types.js";

/**
 * Provider 契约套件：以同一组行为步骤驱动任意 Provider 实现，
 * 断言统一的成功语义、错误映射、超时、取消、重试与密钥边界。
 * 新增第二家模型 Provider 时，只需提供一个工厂并复用本套件。
 */

const schema = z.object({ items: z.array(z.object({ name: z.string() })) });

interface ContractSuiteOptions {
  timeoutMs?: number;
  maxRetries?: number;
  baseDelayMs?: number;
  metrics?: LlmMetricsRecorder;
  sleep?: LlmSleep;
}

interface RecordedRequest {
  url: string;
  authorization: string;
  body: Record<string, unknown>;
}

export interface LlmProviderContractSuite {
  name: string;
  createProvider(
    steps: readonly MockLlmStep[],
    options?: ContractSuiteOptions,
  ): {
    provider: LlmProvider;
    /** Provider 持有的密钥值（如有），用于泄漏断言。 */
    secret?: string;
    /** 底层收到的请求记录（如有），用于断言请求格式。 */
    requests?: RecordedRequest[];
  };
}

function makeRequest(overrides: Partial<LlmStructuredRequest<z.infer<typeof schema>>> = {}) {
  return {
    task: "contract-test",
    systemPrompt: "从内容中提取条目",
    userContent: "契约测试证据：用户偏好中文沟通",
    schemaName: "items",
    schema,
    ...overrides,
  };
}

function assertKind(error: unknown, kind: LlmProviderError["kind"], code: string): boolean {
  assert.ok(error instanceof LlmProviderError, `应为 LlmProviderError，实际：${String(error)}`);
  assert.equal(error.kind, kind);
  assert.equal(error.code, code);
  return true;
}

export function defineLlmProviderContractTests(suite: LlmProviderContractSuite): void {
  const label = (name: string) => `[${suite.name}] ${name}`;

  test(label("结构化输出成功：数据通过 Schema 校验并携带用量"), async () => {
    const metrics = new InMemoryLlmMetricsRecorder();
    const { provider } = suite.createProvider(
      [{ type: "ok", data: { items: [{ name: "偏好中文" }] }, usage: { inputTokens: 11, outputTokens: 7 } }],
      { metrics, sleep: async () => {} },
    );

    const response = await provider.structured(makeRequest());

    assert.deepEqual(response.data, { items: [{ name: "偏好中文" }] });
    assert.equal(response.usage.inputTokens, 11);
    assert.equal(response.usage.outputTokens, 7);
    assert.equal(response.finishReason, "stop");
    assert.equal(response.attempts, 1);
    assert.equal(metrics.summary().calls, 1);
    assert.equal(metrics.summary().failures, 0);
  });

  test(label("响应不是合法 JSON：invalid_response 且不重试"), async () => {
    const metrics = new InMemoryLlmMetricsRecorder();
    const { provider } = suite.createProvider([{ type: "invalid-json" }], {
      metrics,
      maxRetries: 3,
      sleep: async () => {},
    });

    await assert.rejects(
      () => provider.structured(makeRequest()),
      (error) => assertKind(error, "invalid_response", "LLM_INVALID_RESPONSE"),
    );
    assert.equal(metrics.records.length, 1);
  });

  test(label("响应未通过 Schema 校验：invalid_response 且不重试"), async () => {
    const metrics = new InMemoryLlmMetricsRecorder();
    const { provider } = suite.createProvider([{ type: "schema-mismatch", data: { unexpected: 1 } }], {
      metrics,
      maxRetries: 3,
      sleep: async () => {},
    });

    await assert.rejects(
      () => provider.structured(makeRequest()),
      (error) => assertKind(error, "invalid_response", "LLM_INVALID_RESPONSE"),
    );
    assert.equal(metrics.records.length, 1);
  });

  test(label("限流后按 Retry-After 退避重试成功"), async () => {
    const delays: number[] = [];
    const metrics = new InMemoryLlmMetricsRecorder();
    const { provider } = suite.createProvider(
      [{ type: "http-error", status: 429, retryAfterMs: 500 }, { type: "ok", data: { items: [] } }],
      { metrics, sleep: async (ms) => { delays.push(ms); } },
    );

    const response = await provider.structured(makeRequest());
    assert.equal(response.attempts, 2);
    assert.deepEqual(delays, [500]);
    assert.equal(metrics.summary().retries, 1);
  });

  test(label("鉴权失败：auth 错误且不重试"), async () => {
    const metrics = new InMemoryLlmMetricsRecorder();
    const { provider } = suite.createProvider([{ type: "http-error", status: 401 }], {
      metrics,
      maxRetries: 2,
      sleep: async () => {},
    });

    await assert.rejects(
      () => provider.structured(makeRequest()),
      (error) => assertKind(error, "auth", "LLM_AUTH_ERROR"),
    );
    assert.equal(metrics.records.length, 1);
  });

  test(label("服务端 5xx：按退避重试直至成功"), async () => {
    const metrics = new InMemoryLlmMetricsRecorder();
    const { provider } = suite.createProvider(
      [{ type: "http-error", status: 503 }, { type: "http-error", status: 500 }, { type: "ok", data: { items: [] } }],
      { metrics, maxRetries: 2, baseDelayMs: 10, sleep: async () => {} },
    );

    const response = await provider.structured(makeRequest());
    assert.equal(response.attempts, 3);
    assert.equal(metrics.summary().failures, 2);
    assert.equal(metrics.summary().retries, 2);
  });

  test(label("单次尝试超时：归类为 timeout"), async () => {
    const metrics = new InMemoryLlmMetricsRecorder();
    const { provider } = suite.createProvider([{ type: "ok", data: { items: [] }, latencyMs: 5_000 }], {
      metrics,
      timeoutMs: 50,
      maxRetries: 0,
      sleep: async () => {},
    });

    await assert.rejects(
      () => provider.structured(makeRequest()),
      (error) => assertKind(error, "timeout", "LLM_TIMEOUT"),
    );
    assert.equal(metrics.records.length, 1);
  });

  test(label("发起前取消：归类为 canceled 且不触达模型"), async () => {
    const metrics = new InMemoryLlmMetricsRecorder();
    const { provider } = suite.createProvider([{ type: "ok", data: { items: [] } }], {
      metrics,
      maxRetries: 2,
      sleep: async () => {},
    });
    const controller = new AbortController();
    controller.abort();

    await assert.rejects(
      () => provider.structured(makeRequest({ signal: controller.signal })),
      (error) => assertKind(error, "canceled", "LLM_CANCELED"),
    );
    assert.equal(metrics.records.length, 0);
  });

  test(label("错误消息与指标不泄漏密钥"), async () => {
    const metrics = new InMemoryLlmMetricsRecorder();
    const created = suite.createProvider([{ type: "http-error", status: 500 }], {
      metrics,
      maxRetries: 0,
      sleep: async () => {},
    });
    // 契约：无论哪家 Provider，其错误输出都不得包含它持有的密钥值
    const secret = created.secret ?? "CONTRACT-NO-SECRET";

    let captured: unknown;
    try {
      await created.provider.structured(makeRequest());
      assert.fail("应抛出 LlmProviderError");
    } catch (error) {
      captured = error;
    }
    assert.ok(captured instanceof LlmProviderError);
    assert.ok(!captured.message.includes(secret));
    assert.ok(!JSON.stringify(captured).includes(secret));
    assert.ok(!JSON.stringify(metrics.records).includes(secret));
    assert.ok(!JSON.stringify(metrics.summary()).includes(secret));
  });
}

// ---- 默认接入的两个 Provider：Mock 与 OpenAI 兼容 ----

defineLlmProviderContractTests({
  name: "mock",
  createProvider: (steps, options = {}) => ({
    provider: withLlmResilience(new MockLlmProvider({ steps, model: "contract-mock" }), {
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.maxRetries !== undefined ? { maxRetries: options.maxRetries } : {}),
      ...(options.baseDelayMs !== undefined ? { baseDelayMs: options.baseDelayMs } : {}),
      ...(options.metrics !== undefined ? { metrics: options.metrics } : {}),
      ...(options.sleep !== undefined ? { sleep: options.sleep } : {}),
      model: "contract-mock",
    }),
  }),
});

const CONTRACT_SECRET = "sk-contract-secret-3d7f";

defineLlmProviderContractTests({
  name: "openai",
  createProvider: (steps, options = {}) => {
    const { fetchImpl, requests } = createFakeFetchForSteps(steps, CONTRACT_SECRET);
    return {
      secret: CONTRACT_SECRET,
      requests,
      provider: withLlmResilience(
        new OpenAiCompatibleProvider({
          model: "contract-model",
          baseUrl: "http://contract.invalid/v1",
          apiKey: CONTRACT_SECRET,
          fetchImpl,
        }),
        {
          ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
          ...(options.maxRetries !== undefined ? { maxRetries: options.maxRetries } : {}),
          ...(options.baseDelayMs !== undefined ? { baseDelayMs: options.baseDelayMs } : {}),
          ...(options.metrics !== undefined ? { metrics: options.metrics } : {}),
          ...(options.sleep !== undefined ? { sleep: options.sleep } : {}),
          model: "contract-model",
        },
      ),
    };
  },
});

/**
 * 用行为步骤合成 OpenAI 兼容端点的假 fetch：
 * 响应体格式与真实 Chat Completions 一致，错误体故意夹带密钥以验证不泄漏。
 */
function createFakeFetchForSteps(steps: readonly MockLlmStep[], secret: string): {
  fetchImpl: typeof fetch;
  requests: RecordedRequest[];
} {
  const requests: RecordedRequest[] = [];
  let cursor = 0;
  const fetchImpl = (async (
    url: unknown,
    init?: { headers?: Record<string, string>; body?: unknown; signal?: AbortSignal },
  ) => {
    const step = steps[Math.min(cursor, steps.length - 1)]!;
    cursor += 1;
    const headers = init?.headers ?? {};
    requests.push({
      url: String(url),
      authorization: headers.authorization ?? "",
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
    });
    // 与真实 fetch 一致：慢响应期间响应 abort 信号
    if (step.latencyMs && step.latencyMs > 0) await delay(step.latencyMs, init?.signal);

    switch (step.type) {
      case "ok":
      case "schema-mismatch":
        return jsonResponse(200, chatCompletionBody(JSON.stringify(step.data), step.usage), {});
      case "http-error":
        return jsonResponse(
          step.status,
          { error: { message: `upstream failure ${secret}` } },
          step.retryAfterMs !== undefined ? { "retry-after": String(step.retryAfterMs / 1_000) } : {},
        );
      case "invalid-json":
        return jsonResponse(200, chatCompletionBody("不是 JSON {{{", step.usage), {});
      case "network-error":
        throw new TypeError("fetch failed");
    }
  }) as typeof fetch;
  return { fetchImpl, requests };
}

function chatCompletionBody(content: string, usage?: Partial<LlmUsage>): Record<string, unknown> {
  const inputTokens = usage?.inputTokens ?? 11;
  const outputTokens = usage?.outputTokens ?? 7;
  return {
    id: "chatcmpl-contract",
    object: "chat.completion",
    model: "contract-model",
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: inputTokens, completion_tokens: outputTokens, total_tokens: inputTokens + outputTokens },
  };
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function abortError(): Error {
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}

// ---- OpenAI 兼容 Provider 的请求格式与协议细节 ----

test("openai Provider：json_object 模式把 JSON Schema 写入系统指令且请求格式正确", async () => {
  const { fetchImpl, requests } = createFakeFetchForSteps([{ type: "ok", data: { items: [] } }], "k");
  const provider = new OpenAiCompatibleProvider({
    model: "format-model",
    baseUrl: "https://contract.invalid/v1",
    apiKey: "sk-format",
    fetchImpl,
  });

  await provider.structured(makeRequest());

  assert.equal(requests.length, 1);
  const request = requests[0]!;
  assert.equal(request.url, "https://contract.invalid/v1/chat/completions");
  assert.equal(request.authorization, "Bearer sk-format");
  assert.ok(!request.url.includes("sk-format"));

  const body = request.body;
  assert.equal(body.model, "format-model");
  assert.deepEqual(body.response_format, { type: "json_object" });
  assert.equal(body.temperature, 0);
  const messages = body.messages as { role: string; content: string }[];
  assert.equal(messages.length, 2);
  assert.equal(messages[0]!.role, "system");
  assert.ok(messages[0]!.content.includes("JSON Schema"));
  assert.ok(messages[0]!.content.includes('"items"'));
  assert.equal(messages[1]!.role, "user");
  assert.equal(messages[1]!.content, "契约测试证据：用户偏好中文沟通");
});

test("openai Provider：json_schema 模式通过 response_format 传递命名 Schema", async () => {
  const { fetchImpl, requests } = createFakeFetchForSteps([{ type: "ok", data: { items: [] } }], "k");
  const provider = new OpenAiCompatibleProvider({
    model: "format-model",
    baseUrl: "https://contract.invalid/v1",
    apiKey: "sk-format",
    responseMode: "json_schema",
    fetchImpl,
  });

  await provider.structured(makeRequest());

  const body = requests[0]!.body;
  const responseFormat = body.response_format as { type: string; json_schema: { name: string; strict: boolean } };
  assert.equal(responseFormat.type, "json_schema");
  assert.equal(responseFormat.json_schema.name, "items");
  assert.equal(responseFormat.json_schema.strict, true);
  // Schema 已随请求结构传递，不再写入系统指令
  const messages = body.messages as { content: string }[];
  assert.ok(!messages[0]!.content.includes("JSON Schema"));
});

test("openai Provider：网络层失败映射为 network 错误", async () => {
  const provider = new OpenAiCompatibleProvider({
    model: "net-model",
    baseUrl: "https://contract.invalid/v1",
    apiKey: "sk-net",
    fetchImpl: (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch,
  });

  await assert.rejects(
    () => provider.structured(makeRequest()),
    (error) => assertKind(error, "network", "LLM_NETWORK_ERROR"),
  );
});
