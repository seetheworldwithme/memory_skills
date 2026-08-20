import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";

import { createMemorySkillsServer } from "../src/api/http-server.js";
import { SqliteRepository } from "../src/storage/sqlite-repository.js";
import { SqliteVectorIndex } from "../src/retrieval/vector-index.js";
import type { EmbeddingProvider, EmbeddingRequest, EmbeddingResult } from "../src/retrieval/types.js";
import type { ObservabilityEvent } from "../src/observability/events.js";
import type { Scope } from "../src/governance/types.js";

const scope: Scope = { userId: "u1", teamId: "t1", agentId: "a1" };

/** 可控 Embedding Provider：可注入故障，用于验证同步失败不影响治理操作。 */
class FakeEmbeddingProvider implements EmbeddingProvider {
  readonly name = "fake";
  readonly model = "fake-embedding";
  fail = false;

  async embed(request: EmbeddingRequest): Promise<EmbeddingResult> {
    if (this.fail) throw new Error("embedding backend unavailable");
    return {
      vectors: request.texts.map(() => [0.1, 0.2, 0.3, 0.4]),
      model: this.model,
      latencyMs: 0,
      attempts: 1,
    };
  }
}

/** 收集型事件 sink：测试断言自动同步成败事件的载体。 */
class CollectingEventSink {
  readonly events: ObservabilityEvent[] = [];
  emit(event: ObservabilityEvent): void {
    this.events.push(event);
  }
}

/** 造一个 draft 记忆（带来源证据），返回资产 ID。 */
async function seedDraftMemory(base: string, accessKey: string): Promise<string> {
  const evidence = await post(`${base}/v1/evidence`, {
    id: `ev-${Math.random().toString(36).slice(2)}`,
    scope,
    role: "user",
    content: "Always show verification evidence",
  }, accessKey);
  const memory = await post(`${base}/v1/memories`, {
    id: `mem-${Math.random().toString(36).slice(2)}`,
    layer: "l1",
    scope,
    content: "Alice expects verification evidence",
    confidence: 0.9,
    reason: "test",
    sourceEvidenceIds: [evidence.id],
  }, accessKey);
  return memory.id as string;
}

async function post(url: string, body: unknown, accessKey: string): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${accessKey}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  assert.equal(response.status, 200, `POST ${url} failed: ${text}`);
  return JSON.parse(text) as Record<string, unknown>;
}

test("Verify 状态转换成功后自动同步向量索引，无需手动 /v1/retrieval/sync", async () => {
  const repository = new SqliteRepository(":memory:");
  const index = new SqliteVectorIndex("fake-embedding", ":memory:");
  const accessKey = "auto-sync-test-key";
  const server = createMemorySkillsServer({
    repository,
    accessKey,
    embedding: { provider: new FakeEmbeddingProvider(), index },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  try {
    const memoryId = await seedDraftMemory(base, accessKey);
    // Draft 不进索引（自动同步只覆盖可召回资产）
    assert.deepEqual(await index.fingerprints(scope, "memory"), []);

    await post(`${base}/v1/memories/${memoryId}/status`, { scope, target: "verified" }, accessKey);

    // Verify 响应返回时向量已就绪：hybrid 检索不再依赖人工同步
    const fingerprints = await index.fingerprints(scope, "memory");
    assert.deepEqual(fingerprints.map((entry) => entry.assetId), [memoryId]);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    index.close();
    repository.close();
  }
});

test("离开可召回集的状态转换（verified→archived / draft→rejected）自动清理向量行", async () => {
  const repository = new SqliteRepository(":memory:");
  const index = new SqliteVectorIndex("fake-embedding", ":memory:");
  const accessKey = "auto-sync-test-key";
  const server = createMemorySkillsServer({
    repository,
    accessKey,
    embedding: { provider: new FakeEmbeddingProvider(), index },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  try {
    const memoryId = await seedDraftMemory(base, accessKey);
    await post(`${base}/v1/memories/${memoryId}/status`, { scope, target: "verified" }, accessKey);
    assert.equal((await index.fingerprints(scope, "memory")).length, 1);

    await post(`${base}/v1/memories/${memoryId}/status`, { scope, target: "archived" }, accessKey);

    // 不可召回资产的向量行被清理，避免向量通道继续命中已归档内容
    assert.deepEqual(await index.fingerprints(scope, "memory"), []);

    // draft 直接 Reject 的资产从未进索引，同步后同样保持干净
    const rejectedId = await seedDraftMemory(base, accessKey);
    await post(`${base}/v1/memories/${rejectedId}/status`, { scope, target: "rejected" }, accessKey);
    assert.deepEqual(await index.fingerprints(scope, "memory"), []);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    index.close();
    repository.close();
  }
});

test("自动同步失败只记事件，治理状态转换本身不受影响", async () => {
  const repository = new SqliteRepository(":memory:");
  const index = new SqliteVectorIndex("fake-embedding", ":memory:");
  const provider = new FakeEmbeddingProvider();
  const eventSink = new CollectingEventSink();
  const accessKey = "auto-sync-test-key";
  const server = createMemorySkillsServer({
    repository,
    accessKey,
    eventSink,
    embedding: { provider, index },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  try {
    const memoryId = await seedDraftMemory(base, accessKey);
    provider.fail = true;

    const verified = await post(`${base}/v1/memories/${memoryId}/status`, { scope, target: "verified" }, accessKey);
    // 治理操作成功是第一优先级：同步失败不能让 Verify 报错或回滚
    assert.equal((verified.governance as { status: string }).status, "verified");

    const failedEvents = eventSink.events.filter((event) => event.eventType === "retrieval.auto_sync.failed");
    assert.equal(failedEvents.length, 1);
    assert.equal(failedEvents[0]!.trigger, "memory.transition");
    // 失败事件只带错误码与错误名，不携带可能拼接资产正文的错误消息
    assert.equal(failedEvents[0]!.errorName, "Error");

    // Embedding 恢复后，下一次状态转换（或手动同步）可以补齐索引
    provider.fail = false;
    const listed = await post(`${base}/v1/memories/list`, { scope }, accessKey);
    assert.equal((listed.items as Array<{ governance: { status: string } }>)[0]!.governance.status, "verified");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    index.close();
    repository.close();
  }
});

test("词法模式（未注入向量组件）下状态转换不触发同步也不报错", async () => {
  const repository = new SqliteRepository(":memory:");
  const eventSink = new CollectingEventSink();
  const accessKey = "auto-sync-test-key";
  const server = createMemorySkillsServer({ repository, accessKey, eventSink });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  try {
    const memoryId = await seedDraftMemory(base, accessKey);
    const verified = await post(`${base}/v1/memories/${memoryId}/status`, { scope, target: "verified" }, accessKey);
    assert.equal((verified.governance as { status: string }).status, "verified");
    assert.equal(eventSink.events.filter((event) => event.eventType.startsWith("retrieval.auto_sync")).length, 0);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    repository.close();
  }
});

test("自动同步成功时记录携带计数的审计事件", async () => {
  const repository = new SqliteRepository(":memory:");
  const index = new SqliteVectorIndex("fake-embedding", ":memory:");
  const eventSink = new CollectingEventSink();
  const accessKey = "auto-sync-test-key";
  const server = createMemorySkillsServer({
    repository,
    accessKey,
    eventSink,
    embedding: { provider: new FakeEmbeddingProvider(), index },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  try {
    const memoryId = await seedDraftMemory(base, accessKey);
    await post(`${base}/v1/memories/${memoryId}/status`, { scope, target: "verified" }, accessKey);

    const completed = eventSink.events.filter((event) => event.eventType === "retrieval.auto_sync.completed");
    assert.equal(completed.length, 1);
    assert.equal(completed[0]!.embedded, 1);
    assert.equal(completed[0]!.removed, 0);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    index.close();
    repository.close();
  }
});
