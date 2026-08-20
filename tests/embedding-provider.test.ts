import assert from "node:assert/strict";
import test from "node:test";

import { LlmProviderError } from "../src/errors.js";
import {
  createEmbeddingProvider,
  describeEmbeddingConfig,
  resolveEmbeddingConfigFromEnv,
} from "../src/retrieval/embedding-provider.js";
import { MockEmbeddingProvider } from "../src/retrieval/mock-embedding-provider.js";
import { OpenAiCompatibleEmbeddingProvider } from "../src/retrieval/providers/openai-embedding-provider.js";

/** 构造 OpenAI 兼容 /embeddings 成功响应。 */
function embeddingsResponse(vectors: number[][], model = "text-embedding-3-small") {
  return {
    model,
    data: vectors.map((vector, index) => ({ index, embedding: vector })),
    usage: { prompt_tokens: 12, total_tokens: 12 },
  };
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

test("resolveEmbeddingConfigFromEnv 默认 mock 并校验必填项", () => {
  const defaults = resolveEmbeddingConfigFromEnv({});
  assert.deepEqual(defaults, { provider: "mock", model: "mock-embedding" });

  const openai = resolveEmbeddingConfigFromEnv({
    MEMORY_SKILLS_EMBEDDING_PROVIDER: "openai",
    MEMORY_SKILLS_EMBEDDING_MODEL: "text-embedding-3-small",
    MEMORY_SKILLS_EMBEDDING_BASE_URL: "https://emb.example.com/v1",
    MEMORY_SKILLS_EMBEDDING_BATCH_SIZE: "8",
  });
  assert.equal(openai.provider, "openai");
  assert.equal(openai.model, "text-embedding-3-small");
  assert.equal(openai.baseUrl, "https://emb.example.com/v1");
  assert.equal(openai.apiKeyEnv, "OPENAI_API_KEY");
  assert.equal(openai.batchSize, 8);

  assert.throws(
    () => resolveEmbeddingConfigFromEnv({ MEMORY_SKILLS_EMBEDDING_PROVIDER: "openai" }),
    /必须设置 MEMORY_SKILLS_EMBEDDING_MODEL/,
  );
  assert.throws(
    () => resolveEmbeddingConfigFromEnv({ MEMORY_SKILLS_EMBEDDING_BATCH_SIZE: "0" }),
    /MEMORY_SKILLS_EMBEDDING_BATCH_SIZE/,
  );
});

test("describeEmbeddingConfig 显式投影字段且不含密钥值", () => {
  const description = describeEmbeddingConfig({
    provider: "openai",
    model: "m",
    apiKeyEnv: "MY_KEY_ENV",
    costPerMillionTokens: { input: 0.02 },
  });
  assert.deepEqual(description, {
    provider: "openai",
    model: "m",
    baseUrl: null,
    timeoutMs: null,
    maxRetries: null,
    apiKeyEnv: "MY_KEY_ENV",
    batchSize: null,
    costPerMillionTokens: { input: 0.02 },
  });
  assert.ok(!JSON.stringify(description).includes("sk-"));
});

test("createEmbeddingProvider 注册表：mock 可用、未注册名与缺失密钥报错", () => {
  assert.ok(createEmbeddingProvider({ provider: "mock", model: "m" }) instanceof MockEmbeddingProvider);
  assert.throws(() => createEmbeddingProvider({ provider: "ghost", model: "m" }), /未注册的 Embedding Provider/);
  assert.throws(
    () => createEmbeddingProvider({ provider: "openai", model: "m" }, { env: {} }),
    /环境变量 OPENAI_API_KEY 未设置/,
  );
});

test("OpenAI 兼容 Embedding：向量按 index 归位并做 L2 归一化", async () => {
  const calls: unknown[] = [];
  const fetchImpl: typeof fetch = async (_url, init) => {
    calls.push(JSON.parse(String(init?.body)));
    // 故意乱序返回，靠 index 归位
    return jsonResponse(200, {
      model: "m",
      data: [
        { index: 1, embedding: [0, 3, 4] },
        { index: 0, embedding: [3, 4, 0] },
      ],
      usage: { prompt_tokens: 5, total_tokens: 5 },
    });
  };
  const provider = new OpenAiCompatibleEmbeddingProvider({ model: "m", apiKey: "k", fetchImpl });
  const result = await provider.embed({ texts: ["甲", "乙"] });

  assert.deepEqual(result.vectors, [[0.6, 0.8, 0], [0, 0.6, 0.8]]);
  assert.equal(result.model, "m");
  assert.equal(result.usage?.totalTokens, 5);
  assert.equal(result.attempts, 1);
  assert.deepEqual(calls[0], { model: "m", input: ["甲", "乙"] });
});

test("OpenAI 兼容 Embedding：HTTP 错误映射为稳定错误类别", async () => {
  const authFail = new OpenAiCompatibleEmbeddingProvider({
    model: "m", apiKey: "k", fetchImpl: async () => jsonResponse(401, { error: "bad key" }),
  });
  await assert.rejects(authFail.embed({ texts: ["x"] }), (error: unknown) => {
    assert.ok(error instanceof LlmProviderError);
    assert.equal(error.kind, "auth");
    assert.ok(!error.message.includes("bad key"), "错误消息不得拼接响应正文");
    return true;
  });

  const rateLimited = new OpenAiCompatibleEmbeddingProvider({
    model: "m", apiKey: "k", fetchImpl: async () => jsonResponse(429, {}, { "retry-after": "1" }),
  });
  await assert.rejects(rateLimited.embed({ texts: ["x"] }), (error: unknown) => {
    assert.ok(error instanceof LlmProviderError);
    assert.equal(error.kind, "rate_limited");
    assert.equal(error.retryAfterMs, 1000);
    return true;
  });
});

test("OpenAI 兼容 Embedding：可重试错误退避后重试成功", async () => {
  let attempt = 0;
  const sleeps: number[] = [];
  const provider = new OpenAiCompatibleEmbeddingProvider({
    model: "m",
    apiKey: "k",
    maxRetries: 1,
    fetchImpl: async () => {
      attempt += 1;
      if (attempt === 1) return jsonResponse(500, { error: "boom" });
      return jsonResponse(200, embeddingsResponse([[1, 0]]));
    },
    sleep: async (ms: number) => {
      sleeps.push(ms);
    },
  });
  const result = await provider.embed({ texts: ["x"] });
  assert.equal(result.attempts, 2);
  assert.deepEqual(sleeps, [200]);
});

test("OpenAI 兼容 Embedding：响应结构非法时拒绝", async () => {
  const missingData = new OpenAiCompatibleEmbeddingProvider({
    model: "m", apiKey: "k", fetchImpl: async () => jsonResponse(200, { model: "m" }),
  });
  await assert.rejects(missingData.embed({ texts: ["x"] }), /缺少与输入等量的向量/);

  const badVector = new OpenAiCompatibleEmbeddingProvider({
    model: "m",
    apiKey: "k",
    fetchImpl: async () => jsonResponse(200, { data: [{ index: 0, embedding: [1, "oops"] }] }),
  });
  await assert.rejects(badVector.embed({ texts: ["x"] }), /包含非法向量/);
});
