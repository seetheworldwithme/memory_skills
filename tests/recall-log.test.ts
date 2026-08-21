import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";

import { ContextService } from "../src/context/context-service.js";
import { MemoryService } from "../src/memory/memory-service.js";
import { SkillService } from "../src/skills/skill-service.js";
import { SqliteRepository } from "../src/storage/sqlite-repository.js";
import type { Scope } from "../src/governance/types.js";
import type { EventSink } from "../src/observability/event-sink.js";
import type { ObservabilityEvent } from "../src/observability/events.js";
import { createMemorySkillsServer } from "../src/api/http-server.js";

/** 测试用内存事件收集器。 */
class RecordingSink implements EventSink {
  readonly events: ObservabilityEvent[] = [];
  emit(event: ObservabilityEvent): void {
    this.events.push(event);
  }
}

const scope: Scope = { userId: "log-user", teamId: "team-log", agentId: "agent-log" };

function seed(repository: SqliteRepository): void {
  const memory = new MemoryService(repository);
  const evidence = memory.capture({
    id: "log-ev-1",
    scope,
    role: "user",
    content: "用户偏好验证日志记录",
  });
  const asset = memory.propose({
    id: "log-mem-1",
    layer: "l1",
    scope,
    content: "用户偏好验证日志记录，召回日志必须可回放",
    confidence: 0.9,
    reason: "recall log fixture",
    sourceEvidenceIds: [evidence.id],
  });
  memory.transition(asset.id, scope, "verified");
}

test("recall_log 仓储 round-trip：插入、按 ID 查询、按作用域列出", () => {
  const repository = new SqliteRepository(":memory:");
  const record = {
    requestId: "req-1",
    query: "验证日志",
    scope,
    retrievalStrategy: "lexical",
    memoryHits: [{ id: "log-mem-1", score: 0.1234 }],
    skillHits: [],
    durationMs: 5.5,
    createdAt: "2026-08-21T00:00:00.000Z",
  };
  repository.insertRecallLog(record);

  assert.deepEqual(repository.getRecallLog("req-1"), record);
  assert.equal(repository.getRecallLog("missing"), undefined);

  // 带 sessionId 的作用域隔离：不同 session 互不可见
  const { retrievalStrategy: _strategy, durationMs: _duration, ...bare } = record;
  repository.insertRecallLog({
    ...bare,
    requestId: "req-2",
    scope: { ...scope, sessionId: "session-b" },
  });
  const listed = repository.listRecallLog(scope);
  assert.equal(listed.length, 1);
  assert.equal(listed[0]!.requestId, "req-1");
  const sessionListed = repository.listRecallLog({ ...scope, sessionId: "session-b" });
  assert.equal(sessionListed.length, 1);
  assert.equal(sessionListed[0]!.requestId, "req-2");
  // 可选字段缺省时 round-trip 不产生 undefined 键
  assert.equal("retrievalStrategy" in sessionListed[0]!, false);
  assert.equal("durationMs" in sessionListed[0]!, false);

  // 同一 requestId 重复写入由主键约束拒绝
  assert.throws(() => repository.insertRecallLog(record));
});

test("召回成功后写入召回日志：命中资产与分数可回放", async () => {
  const repository = new SqliteRepository(":memory:");
  seed(repository);
  const context = new ContextService(
    new MemoryService(repository),
    new SkillService(repository),
    () => "req-recall-1",
    { eventSink: new RecordingSink() },
    {},
    { repository },
  );

  const response = await context.recall({ query: "验证日志", scope });
  assert.equal(response.memories.length, 1);

  const record = repository.getRecallLog("req-recall-1");
  assert.ok(record);
  assert.equal(record!.query, "验证日志");
  assert.equal(record!.scope.userId, scope.userId);
  assert.equal(record!.retrievalStrategy, "lexical");
  assert.deepEqual(record!.memoryHits.map((hit) => hit.id), ["log-mem-1"]);
  assert.ok(record!.memoryHits[0]!.score! > 0);
  assert.deepEqual(record!.skillHits, []);
  assert.ok(record!.durationMs !== undefined && record!.durationMs >= 0);
});

test("召回日志写入失败不影响召回主流程，只记 recall.log.failed 事件", async () => {
  const repository = new SqliteRepository(":memory:");
  seed(repository);
  const sink = new RecordingSink();
  // 注入 insertRecallLog 必炸的代理仓储，模拟日志落库故障
  const broken: SqliteRepository = new Proxy(repository, {
    get(target, property, receiver) {
      if (property === "insertRecallLog") {
        return () => {
          throw new Error("recall log disk full");
        };
      }
      return Reflect.get(target, property, receiver);
    },
  });
  const context = new ContextService(
    new MemoryService(repository),
    new SkillService(repository),
    () => "req-recall-broken",
    { eventSink: sink },
    {},
    { repository: broken },
  );

  // 召回本身照常成功
  const response = await context.recall({ query: "验证日志", scope });
  assert.equal(response.memories.length, 1);
  assert.equal(response.requestId, "req-recall-broken");

  // 失败只产生 recall.log.failed 事件：错误码在、查询原文与资产内容绝不在
  const failedEvents = sink.events.filter((event) => event.eventType === "recall.log.failed");
  assert.equal(failedEvents.length, 1);
  const failed = failedEvents[0] as Extract<ObservabilityEvent, { eventType: "recall.log.failed" }>;
  assert.equal(failed.requestId, "req-recall-broken");
  assert.equal(failed.errorName, "Error");
  const serialized = JSON.stringify(sink.events);
  assert.ok(!serialized.includes("验证日志"), "事件不得携带查询原文");
});

test("HTTP 端点：recall-log/list 与 recall-log/get 按作用域返回召回日志", async () => {
  const repository = new SqliteRepository(":memory:");
  seed(repository);
  const accessKey = "recall-log-test-key";
  const server = createMemorySkillsServer({ repository, accessKey });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;

  try {
    // 走统一契约端点触发一次真实召回（内部落 recall_log）
    const recall = await fetch(`${base}/v1/context/recall`, {
      method: "POST",
      headers: { authorization: `Bearer ${accessKey}`, "content-type": "application/json" },
      body: JSON.stringify({ query: "验证日志", scope }),
    }).then((response) => response.json());
    assert.equal(recall.memories.length, 1);

    const listed = await fetch(`${base}/v1/recall-log/list`, {
      method: "POST",
      headers: { authorization: `Bearer ${accessKey}`, "content-type": "application/json" },
      body: JSON.stringify({ scope }),
    });
    assert.equal(listed.status, 200);
    const { items } = await listed.json();
    assert.equal(items.length, 1);
    assert.equal(items[0].requestId, recall.requestId);
    assert.equal(items[0].query, "验证日志");
    assert.deepEqual(items[0].memoryHits.map((hit: { id: string }) => hit.id), ["log-mem-1"]);

    const single = await fetch(`${base}/v1/recall-log/get`, {
      method: "POST",
      headers: { authorization: `Bearer ${accessKey}`, "content-type": "application/json" },
      body: JSON.stringify({ requestId: recall.requestId }),
    });
    assert.equal(single.status, 200);
    assert.equal((await single.json()).requestId, recall.requestId);

    const missing = await fetch(`${base}/v1/recall-log/get`, {
      method: "POST",
      headers: { authorization: `Bearer ${accessKey}`, "content-type": "application/json" },
      body: JSON.stringify({ requestId: "no-such-request" }),
    });
    assert.equal(missing.status, 404);

    // 缺 scope / requestId 的请求被 400 拒绝
    const badList = await fetch(`${base}/v1/recall-log/list`, {
      method: "POST",
      headers: { authorization: `Bearer ${accessKey}`, "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(badList.status, 400);
  } finally {
    server.close();
  }
});
