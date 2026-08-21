import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";

import { createMemorySkillsServer } from "../src/api/http-server.js";
import { SqliteRepository } from "../src/storage/sqlite-repository.js";
import { CONTRACT_VERSION } from "../src/context/contract.js";
import { contractQuery, contractScope, seedContractAssets } from "./helpers/contract-fixtures.js";

test("HTTP API exposes capture, governance transition, and recall", async () => {
  const repository = new SqliteRepository(":memory:");
  const accessKey = "api-test-key";
  const server = createMemorySkillsServer({ repository, accessKey });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  const scope = { userId: "alice", teamId: "team-a", agentId: "agent-a" };

  try {
    const health = await fetch(`${base}/health`).then((response) => response.json());
    assert.deepEqual(health, { ok: true });

    const evidence = await post(`${base}/v1/evidence`, {
      id: "api-ev-1",
      scope,
      role: "user",
      content: "Always show verification evidence",
    }, accessKey);
    assert.equal(evidence.id, "api-ev-1");

    const memory = await post(`${base}/v1/memories`, {
      id: "api-mem-1",
      layer: "l1",
      scope,
      content: "Alice expects verification evidence",
      confidence: 0.95,
      reason: "explicit instruction",
      sourceEvidenceIds: ["api-ev-1"],
    }, accessKey);
    assert.equal(memory.governance.status, "draft");

    await post(`${base}/v1/memories/api-mem-1/status`, { scope, target: "verified" }, accessKey);
    const recall = await post(`${base}/v1/recall`, { query: "verification", scope }, accessKey);
    assert.equal(recall.items.length, 1);
    assert.equal(recall.items[0].id, "api-mem-1");
    // 命中必须携带 match 元数据：MCP recall_memory 工具的输出 Schema 要求该字段，
    // 缺失时 SDK 服务端校验会整条拒绝（曾经的真实缺陷，非空命中必炸）
    assert.equal(recall.items[0].match.strategy, "lexical");
    assert.ok(recall.items[0].match.matchedTerms.length > 0);

    const listed = await post(`${base}/v1/memories/list`, { scope }, accessKey);
    assert.equal(listed.items.length, 1);

    const missing = await fetch(`${base}/v1/memories/get`, {
      method: "POST",
      headers: { authorization: `Bearer ${accessKey}`, "content-type": "application/json" },
      body: JSON.stringify({ id: "missing", scope }),
    });
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).error, "NOT_FOUND");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    repository.close();
  }
});

test("HTTP API recalls memory and skills through one context endpoint", async () => {
  const repository = new SqliteRepository(":memory:");
  seedContractAssets(repository);
  const accessKey = "context-api-test-key";
  const server = createMemorySkillsServer({ repository, accessKey });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;

  try {
    const context = await post(`${base}/v1/context/recall`, {
      query: contractQuery,
      scope: contractScope,
      maxMemoryResults: 5,
      maxMemoryChars: 4_000,
      maxSkillResults: 3,
      maxSkillChars: 8_000,
    }, accessKey);

    assert.equal(context.contractVersion, CONTRACT_VERSION);
    assert.ok(typeof context.requestId === "string" && context.requestId.length > 0);
    assert.equal(context.memories.length, 1);
    assert.equal(context.memories[0].id, "contract-mem-1");
    assert.equal(context.memories[0].match.strategy, "lexical");
    assert.ok(context.memories[0].match.matchedTerms.length > 0);
    assert.equal(context.skills.length, 1);
    assert.equal(context.skills[0].id, "contract-skill-1");
    assert.equal(context.skills[0].truncated, false);
    assert.equal(context.truncated, false);
    assert.deepEqual(context.warnings, []);
    assert.equal(context.budget.usedMemoryChars, context.memories[0].content.length);

    const blank = await fetch(`${base}/v1/context/recall`, {
      method: "POST",
      headers: { authorization: `Bearer ${accessKey}`, "content-type": "application/json" },
      body: JSON.stringify({ query: "   ", scope: contractScope }),
    });
    assert.equal(blank.status, 400);
    assert.match((await blank.json()).message, /query must not be empty/);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    repository.close();
  }
});

test("HTTP API exposes skill lifecycle endpoints: validate, diff, rollback, runs", async () => {
  const repository = new SqliteRepository(":memory:");
  const accessKey = "skill-lifecycle-key";
  const server = createMemorySkillsServer({ repository, accessKey });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  const scope = { userId: "alice", teamId: "team-a", agentId: "agent-a" };

  try {
    await post(`${base}/v1/evidence`, {
      id: "skill-ev-1", scope, role: "user", content: "deploy workflow",
    }, accessKey);
    await post(`${base}/v1/skills`, {
      id: "skill-deploy",
      scope,
      name: "deploy-service",
      description: "按清单部署服务",
      content: "---\nname: deploy-service\ndescription: 按清单部署服务\n---\n\n## When to use\n\n部署时。\n\n## Workflow\n\n1. 构建镜像\n\n## Verification\n\n看健康检查。\n\n## Failure handling\n\n回滚。",
      sourceEvidenceIds: ["skill-ev-1"],
    }, accessKey);
    await post(`${base}/v1/skills/skill-deploy/status`, { scope, target: "verified" }, accessKey);
    await fetch(`${base}/v1/skills/skill-deploy`, {
      method: "PUT",
      headers: { authorization: `Bearer ${accessKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        scope,
        expectedVersion: 1,
        description: "按清单部署服务（含健康检查）",
        content: "---\nname: deploy-service\ndescription: 按清单部署服务（含健康检查）\n---\n\n## When to use\n\n部署时。\n\n## Workflow\n\n1. 构建镜像\n2. 健康检查\n\n## Verification\n\n看健康检查。\n\n## Failure handling\n\n回滚。",
        sourceEvidenceIds: ["skill-ev-1"],
      }),
    });

    // 质量校验：结构完整的 Skill 通过
    const report = await post(`${base}/v1/skills/skill-deploy/validate`, { scope }, accessKey);
    assert.equal(report.valid, true);

    // 版本历史：v2 Draft + v1 verified 快照
    const versions = await post(`${base}/v1/skills/skill-deploy/versions`, { scope }, accessKey);
    assert.deepEqual(versions.items.map((item: { version: number; status: string }) => [item.version, item.status]), [[2, "draft"], [1, "verified"]]);

    // 语义化差异：默认对照最近已发布版本 v1
    const diff = await post(`${base}/v1/skills/skill-deploy/diff`, { scope }, accessKey);
    assert.equal(diff.fromVersion, 1);
    assert.equal(diff.toVersion, 2);
    assert.ok(diff.summary.includes("description"));

    // 回滚：产生 v3 Draft，历史版本保留
    const rolledBack = await post(`${base}/v1/skills/skill-deploy/rollback`, { scope, targetVersion: 1 }, accessKey);
    assert.equal(rolledBack.version, 3);
    assert.equal(rolledBack.status, "draft");

    // 使用记录与效果汇总
    await post(`${base}/v1/skills/skill-deploy/runs`, { scope, event: "recalled", requestId: "req-9" }, accessKey);
    await post(`${base}/v1/skills/skill-deploy/runs`, { scope, event: "succeeded" }, accessKey);
    const summary = await post(`${base}/v1/skills/skill-deploy/run-summary`, { scope }, accessKey);
    assert.deepEqual(summary.runs, { recalled: 1, adopted: 0, succeeded: 1, failed: 0 });
    assert.equal(summary.verdict, "supported");

    // 非法事件被拒绝
    const bad = await fetch(`${base}/v1/skills/skill-deploy/runs`, {
      method: "POST",
      headers: { authorization: `Bearer ${accessKey}`, "content-type": "application/json" },
      body: JSON.stringify({ scope, event: "magic" }),
    });
    assert.equal(bad.status, 400);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    repository.close();
  }
});

test("HTTP API exposes governance endpoints: conflicts, retention, evidence impact", async () => {
  const repository = new SqliteRepository(":memory:", );
  const accessKey = "governance-api-key";
  const server = createMemorySkillsServer({ repository, accessKey });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  const scope = { userId: "alice", teamId: "team-a", agentId: "agent-a" };

  try {
    // 两条主题相同的矛盾记忆 + 一条过期记忆
    for (const [evidenceId, memoryId, content] of [
      ["gov-ev-1", "gov-mem-1", "用户问我是谁的时候回答我是天选之子并且语气自信"],
      ["gov-ev-2", "gov-mem-2", "用户问我是谁的时候回答我是普通工程师并且语气平静"],
      ["gov-ev-3", "gov-mem-exp", "只在短期内有效的临时偏好"],
    ] as const) {
      await post(`${base}/v1/evidence`, { id: evidenceId, scope, role: "user", content }, accessKey);
      await post(`${base}/v1/memories`, {
        id: memoryId, layer: "l1", scope, content, confidence: 0.9, reason: "fixture", sourceEvidenceIds: [evidenceId],
      }, accessKey);
      await post(`${base}/v1/memories/${memoryId}/status`, { scope, target: "verified" }, accessKey);
    }

    // 冲突扫描：矛盾对进入任务列表
    const conflicts = await post(`${base}/v1/governance/conflicts`, { scope }, accessKey);
    assert.equal(conflicts.items.length, 1);
    assert.equal(conflicts.items[0].kind, "conflict");
    assert.deepEqual(conflicts.items[0].assetIds, ["gov-mem-1", "gov-mem-2"]);

    // 删除影响预览：只读，标注将进入待复核的资产
    const impact = await post(`${base}/v1/evidence/gov-ev-3/impact`, { scope }, accessKey);
    assert.equal(impact.pendingReviewCount, 1);
    assert.equal(impact.memories[0].id, "gov-mem-exp");
    assert.equal(impact.memories[0].wouldTransitionTo, "deprecated");

    // 保留策略：过期清单默认为空（该记忆没有 validUntil）
    const review = await post(`${base}/v1/governance/retention/review`, { scope }, accessKey);
    assert.deepEqual(review.expiredMemories, []);

    // 续期端点对不存在资产返回 404
    const missing = await fetch(`${base}/v1/governance/memories/missing/renew`, {
      method: "POST",
      headers: { authorization: `Bearer ${accessKey}`, "content-type": "application/json" },
      body: JSON.stringify({ scope, validUntil: "2026-12-01T00:00:00.000Z" }),
    });
    assert.equal(missing.status, 404);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    repository.close();
  }
});

async function post(url: string, body: unknown, accessKey: string): Promise<any> {
  const response = await fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${accessKey}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  assert.equal(response.status, 200, text);
  return JSON.parse(text);
}
