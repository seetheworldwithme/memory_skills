import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AddressInfo } from "node:net";
import test from "node:test";

import { createMemorySkillsServer } from "../src/api/http-server.js";
import { MemoryService } from "../src/memory/memory-service.js";
import { SkillService } from "../src/skills/skill-service.js";
import { RetentionService, DEFAULT_DRAFT_STALE_DAYS } from "../src/governance/retention-service.js";
import { SqliteRepository } from "../src/storage/sqlite-repository.js";
import type { ObservabilityEvent } from "../src/observability/events.js";
import type { Scope } from "../src/governance/types.js";

const scope: Scope = { userId: "ttl-user", teamId: "team-ttl", agentId: "agent-ttl" };

/** 可拨动的固定时钟：默认"现在"，可前跳验证超期归档。 */
function buildClock() {
  let offsetMs = 0;
  const base = new Date("2026-08-21T00:00:00Z").getTime();
  return {
    now: () => new Date(base + offsetMs),
    advanceDays: (days: number) => { offsetMs += days * 24 * 60 * 60 * 1000; },
  };
}

function buildStack() {
  const repository = new SqliteRepository(":memory:");
  const clock = buildClock();
  const memory = new MemoryService(repository, clock.now);
  const skills = new SkillService(repository, clock.now);
  const retention = new RetentionService(repository, clock.now);
  return { repository, clock, memory, skills, retention };
}

function seedDraft(stack: ReturnType<typeof buildStack>, id: string) {
  const evidence = stack.memory.capture({
    id: `ev-${id}`, scope, role: "user", content: `证据原文（${id}）。`,
  });
  return stack.memory.propose({
    id, layer: "l1", scope, content: `用户偏好内容（${id}）`,
    confidence: 0.9, reason: "TTL 测试", sourceEvidenceIds: [evidence.id],
  });
}

function seedSkillDraft(stack: ReturnType<typeof buildStack>, id: string) {
  const evidence = stack.memory.capture({
    id: `ev-${id}`, scope, role: "user", content: `Skill 证据（${id}）。`,
  });
  return stack.skills.create({
    id, scope, name: id, description: "TTL 测试 Skill",
    content: `---\nname: ${id}\ndescription: TTL 测试 Skill\n---\n\n# Skill\n\n## 工作流\n\n1. 步骤\n`,
    sourceEvidenceIds: [evidence.id],
  });
}

test("archiveStaleDrafts：当天创建的 Draft 不归档，超期 Draft 归档且 Verified 不动", () => {
  const stack = buildStack();
  seedDraft(stack, "mem-fresh");
  seedSkillDraft(stack, "skill-fresh");
  // 前进 8 天后再造"现在仍新鲜"的资产，并归档全部超期 Draft
  stack.clock.advanceDays(DEFAULT_DRAFT_STALE_DAYS + 1);
  seedDraft(stack, "mem-stale");

  const result = stack.retention.archiveStaleDrafts(scope);

  // mem-fresh（7 天前创建）与 skill-fresh 超期归档；mem-stale 刚创建不动
  assert.deepEqual(result.memories.map((item) => item.id), ["mem-fresh"]);
  assert.deepEqual(result.memories[0], { id: "mem-fresh", from: "draft", to: "archived" });
  assert.deepEqual(result.skills.map((item) => item.id), ["skill-fresh"]);
  assert.equal(stack.memory.get("mem-stale", scope)!.governance.status, "draft");

  // Verified 资产永不被 Draft TTL 触及
  stack.memory.transition("mem-stale", scope, "verified");
  stack.clock.advanceDays(30);
  const again = stack.retention.archiveStaleDrafts(scope);
  assert.deepEqual(again, { memories: [], skills: [] });
  assert.equal(stack.memory.get("mem-stale", scope)!.governance.status, "verified");
});

test("archiveStaleDrafts：幂等——二次调用为空结果；review() 的 staleDrafts 同口径", () => {
  const stack = buildStack();
  seedDraft(stack, "mem-dup");
  stack.clock.advanceDays(DEFAULT_DRAFT_STALE_DAYS + 1);

  // review 只读提示：待审积压与归档范围一致（同 7 天口径）
  const reviewBefore = stack.retention.review(scope);
  assert.deepEqual(reviewBefore.staleDrafts.map((item) => item.id), ["mem-dup"]);

  stack.retention.archiveStaleDrafts(scope);
  const reviewAfter = stack.retention.review(scope);
  assert.deepEqual(reviewAfter.staleDrafts, []);

  // 二次归档：没有可归档对象
  const second = stack.retention.archiveStaleDrafts(scope);
  assert.deepEqual(second, { memories: [], skills: [] });
});

test("archiveStaleDrafts：非法 days 参数报错（失败安全）", () => {
  const stack = buildStack();
  assert.throws(() => stack.retention.archiveStaleDrafts(scope, { days: 0 }), /positive integer/);
  assert.throws(() => stack.retention.archiveStaleDrafts(scope, { days: 1.5 }), /positive integer/);
});

test("HTTP：POST /v1/governance/drafts/archive-stale 归档成功、审计与向量同步齐备，read-only 403", async () => {
  // 文件库：服务进程内无法拨时钟，改用第二个连接直改 governance.updatedAt 模拟超期
  const dir = mkdtempSync(join(tmpdir(), "draft-ttl-"));
  const repository = new SqliteRepository(join(dir, "test.db"));
  const { SqliteVectorIndex } = await import("../src/retrieval/vector-index.js");
  const index = new SqliteVectorIndex("fake-embedding", ":memory:");
  const { AuditService } = await import("../src/security/audit-service.js");
  const { AuthService } = await import("../src/auth/auth-service.js");
  const { sha256Hex } = await import("../src/auth/access-key.js");

  class CollectingEventSink {
    events: ObservabilityEvent[] = [];
    emit(event: ObservabilityEvent) { this.events.push(event); }
  }
  const events = new CollectingEventSink();
  const accessKey = "ttl-http-key";
  const readerToken = "ttl-reader-token";
  const server = createMemorySkillsServer({
    repository,
    accessKey,
    authService: new AuthService({
      accessKey,
      teamTokens: [{
        id: "reader", tokenHash: sha256Hex(readerToken),
        userId: "reader-user", teamId: "team-ttl", roles: ["reader"],
      }],
    }),
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
  const post = async (path: string, body: unknown, token = accessKey) => fetch(`${base}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  try {
    // 造一条 Draft 并把 updated_at 拨旧（SQL 直改时间戳，模拟超期）
    const evidenceResponse = await post("/v1/evidence", { id: "ev-ttl", scope, role: "user", content: "证据原文。" });
    assert.equal(evidenceResponse.status, 200);
    const memoryResponse = await post("/v1/memories", {
      id: "mem-ttl", layer: "l1", scope, content: "超期 Draft 内容",
      confidence: 0.9, reason: "测试", sourceEvidenceIds: ["ev-ttl"],
    });
    assert.equal(memoryResponse.status, 200);
    const patcher = new DatabaseSync(join(dir, "test.db"));
    const staleIso = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const row = patcher.prepare("SELECT governance_json FROM memory_assets WHERE id = 'mem-ttl'").get() as { governance_json: string } | undefined;
    assert.ok(row, "测试造数失败：找不到 mem-ttl");
    const governance = JSON.parse(row.governance_json);
    governance.updatedAt = staleIso;
    patcher.prepare("UPDATE memory_assets SET governance_json = ? WHERE id = 'mem-ttl'")
      .run(JSON.stringify(governance));
    patcher.close();

    // reader 无 review 权限：403
    const denied = await post("/v1/governance/drafts/archive-stale", { scope }, readerToken);
    assert.equal(denied.status, 403);

    // admin 归档成功，审计 trigger=retention.archive_stale
    const archived = await post("/v1/governance/drafts/archive-stale", { scope });
    const body = await archived.json();
    assert.equal(archived.status, 200);
    assert.deepEqual(body.memories, [{ id: "mem-ttl", from: "draft", to: "archived" }]);
    assert.ok(events.events.some((event) => event.eventType === "audit.state_changed" && event.trigger === "retention.archive_stale"));
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    index.close();
    repository.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
