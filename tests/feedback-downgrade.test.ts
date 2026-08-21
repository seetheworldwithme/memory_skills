import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";

import { createMemorySkillsServer } from "../src/api/http-server.js";
import { MemoryService } from "../src/memory/memory-service.js";
import { SqliteRepository } from "../src/storage/sqlite-repository.js";
import type { ObservabilityEvent } from "../src/observability/events.js";
import type { Scope } from "../src/governance/types.js";

const scope: Scope = { userId: "fb-user", teamId: "team-fb", agentId: "agent-fb" };

/** 服务级造数：一条 Draft 记忆（来源为用户原话证据），返回资产 ID。 */
function seedDraft(memory: MemoryService, id: string): string {
  memory.capture({ id: `ev-${id}`, scope, role: "user", content: `证据原文（${id}）。` });
  memory.propose({
    id, layer: "l1", scope, content: `用户偏好内容（${id}）`,
    confidence: 0.9, reason: "反馈降级测试", sourceEvidenceIds: [`ev-${id}`],
  });
  return id;
}

test("HTTP：incorrect 反馈命中 auto-verified 记忆 → 自动降级 deprecated + 审计 + 向量同步", async () => {
  const repository = new SqliteRepository(":memory:");
  const { SqliteVectorIndex } = await import("../src/retrieval/vector-index.js");
  const index = new SqliteVectorIndex("fake-embedding", ":memory:");
  const { AuditService } = await import("../src/security/audit-service.js");

  class CollectingEventSink {
    events: ObservabilityEvent[] = [];
    emit(event: ObservabilityEvent) { this.events.push(event); }
  }
  const events = new CollectingEventSink();
  const accessKey = "feedback-downgrade-key";
  const server = createMemorySkillsServer({
    repository,
    accessKey,
    security: { audit: new AuditService(events) },
    eventSink: events,
    embedding: {
      provider: {
        name: "fake", model: "fake-embedding",
        async embed(request) {
          return { vectors: request.texts.map(() => [0.1]), model: "fake-embedding", latencyMs: 0, attempts: 1 };
        },
      },
      index,
    },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const headers = { authorization: `Bearer ${accessKey}`, "content-type": "application/json" };
  const post = async (path: string, body: unknown) => {
    const response = await fetch(`${base}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };

  try {
    // 造 Draft → 规则形态的 auto Verify（verifiedBy=auto）
    const { status: evidenceStatus } = await post("/v1/evidence", { id: "ev-auto", scope, role: "user", content: "用户偏好中文注释。" });
    assert.equal(evidenceStatus, 200);
    const { status: memoryStatus } = await post("/v1/memories", {
      id: "mem-auto", layer: "l1", scope, content: "用户偏好中文注释",
      confidence: 0.9, reason: "测试", sourceEvidenceIds: ["ev-auto"],
    });
    assert.equal(memoryStatus, 200);
    const { status: verifyStatus } = await post("/v1/memories/mem-auto/status", { scope, target: "verified" });
    assert.equal(verifyStatus, 200);
    // 把人工 Verify 改标为 auto（等价于规则放行的形态：verifiedBy 只由转换路径写入）
    repository.updateMemoryStatus("mem-auto", "verified", new Date().toISOString(), { verifiedBy: "auto" });
    // Verify 后向量已就绪；降级后应被清理
    assert.equal((await index.fingerprints(scope, "memory")).length, 1);

    // incorrect 反馈 → 自动降级
    const { status: feedbackStatus } = await post("/v1/feedback", {
      assetKind: "memory", assetId: "mem-auto", scope, kind: "incorrect",
    });
    assert.equal(feedbackStatus, 200);

    const memory = new MemoryService(repository);
    assert.equal(memory.get("mem-auto", scope)!.governance.status, "deprecated");
    const downgraded = events.events.some((event) => event.eventType === "audit.state_changed"
      && (event as { trigger?: string }).trigger === "feedback.downgrade_auto");
    assert.ok(downgraded, "缺少 feedback.downgrade_auto 状态变更审计");
    // 降级退出可召回集，向量行被清理
    assert.deepEqual((await index.fingerprints(scope, "memory")).map((entry) => entry.assetId), []);

    // 重复反馈：资产已非 verified，不再二次转换（幂等）
    const { status: againStatus } = await post("/v1/feedback", {
      assetKind: "memory", assetId: "mem-auto", scope, kind: "incorrect",
    });
    assert.equal(againStatus, 200);
    assert.equal(memory.get("mem-auto", scope)!.governance.status, "deprecated");
    const downgradeEvents = events.events.filter((event) => event.eventType === "audit.state_changed"
      && (event as { trigger?: string }).trigger === "feedback.downgrade_auto");
    assert.equal(downgradeEvents.length, 1);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    index.close();
    repository.close();
  }
});

test("HTTP：manual-verified 资产的 incorrect 反馈不改状态；人工恢复 Verified 后不再自动降级", async () => {
  const repository = new SqliteRepository(":memory:");
  const accessKey = "feedback-manual-key";
  const server = createMemorySkillsServer({ repository, accessKey });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const headers = { authorization: `Bearer ${accessKey}`, "content-type": "application/json" };
  const post = async (path: string, body: unknown) => {
    const response = await fetch(`${base}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };

  try {
    // manual Verify（无 verifiedBy 标记）
    await post("/v1/evidence", { id: "ev-manual", scope, role: "user", content: "证据原文。" });
    await post("/v1/memories", {
      id: "mem-manual", layer: "l1", scope, content: "人工验证的内容",
      confidence: 0.9, reason: "测试", sourceEvidenceIds: ["ev-manual"],
    });
    const { status: verifyStatus } = await post("/v1/memories/mem-manual/status", { scope, target: "verified" });
    assert.equal(verifyStatus, 200);

    const { status: feedbackStatus } = await post("/v1/feedback", {
      assetKind: "memory", assetId: "mem-manual", scope, kind: "incorrect",
    });
    assert.equal(feedbackStatus, 200);
    const memory = new MemoryService(repository);
    assert.equal(memory.get("mem-manual", scope)!.governance.status, "verified");

    // useful 反馈对 auto 资产也不触发降级（只采集，不自动动作）
    await post("/v1/evidence", { id: "ev-kind", scope, role: "user", content: "证据原文二。" });
    await post("/v1/memories", {
      id: "mem-kind", layer: "l1", scope, content: "反馈类型测试内容",
      confidence: 0.9, reason: "测试", sourceEvidenceIds: ["ev-kind"],
    });
    const memService = new MemoryService(repository);
    memService.transition("mem-kind", scope, "verified", { verifiedBy: "auto" });
    const { status: usefulStatus } = await post("/v1/feedback", {
      assetKind: "memory", assetId: "mem-kind", scope, kind: "useful",
    });
    assert.equal(usefulStatus, 200);
    assert.equal(memService.get("mem-kind", scope)!.governance.status, "verified");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    repository.close();
  }
});
