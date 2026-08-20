import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";

import { createMemorySkillsServer } from "../src/api/http-server.js";
import { FeedbackService } from "../src/feedback/feedback-service.js";
import { FEEDBACK_KINDS, type FeedbackKind } from "../src/feedback/types.js";
import { SqliteRepository } from "../src/storage/sqlite-repository.js";
import type { Scope } from "../src/governance/types.js";

const scope: Scope = { userId: "u1", teamId: "t1", agentId: "a1" };
const otherScope: Scope = { userId: "u2", teamId: "t1", agentId: "a1" };

/** 造一条带来源证据的记忆资产并返回入库后的 updatedAt（作为内容代次标识）。 */
function seedMemory(repository: SqliteRepository, id: string, content: string, assetScope: Scope = scope): string {
  repository.captureEvidence({
    id: `${id}-ev`,
    scope: assetScope,
    role: "user",
    content,
    capturedAt: "2026-08-20T00:00:00Z",
  });
  return repository.insertMemory({
    id,
    layer: "l1",
    scope: assetScope,
    content,
    governance: {
      status: "verified",
      confidence: 0.9,
      createdReason: "test",
      createdAt: "2026-08-20T00:00:00Z",
      updatedAt: "2026-08-20T00:00:00Z",
      sensitivity: "normal",
    },
    sources: [{ evidenceId: `${id}-ev`, capturedAt: "2026-08-20T00:00:00Z" }],
  }).governance.updatedAt;
}

function seedSkill(repository: SqliteRepository, id: string): void {
  repository.captureEvidence({
    id: `${id}-ev`,
    scope,
    role: "user",
    content: "evidence",
    capturedAt: "2026-08-20T00:00:00Z",
  });
  repository.insertSkill({
    id,
    scope,
    name: "demo-skill",
    description: "demo",
    content: "---\nname: demo-skill\ndescription: demo\n---\n\n# demo\n",
    version: 1,
    status: "verified",
    sources: [{ evidenceId: `${id}-ev`, capturedAt: "2026-08-20T00:00:00Z" }],
    createdAt: "2026-08-20T00:00:00Z",
    updatedAt: "2026-08-20T00:00:00Z",
  });
}

test("接受四类反馈并关联召回 requestId 与资产版本", () => {
  const repository = new SqliteRepository(":memory:");
  const service = new FeedbackService(repository);
  const memoryUpdatedAt = seedMemory(repository, "mem-1", "用户偏好中文");
  seedSkill(repository, "skill-1");

  const memoryFeedback = service.submit({
    id: "fb-1",
    assetKind: "memory",
    assetId: "mem-1",
    scope,
    kind: "incorrect",
    requestId: "req-abc",
    comment: "与最新说法矛盾",
  });
  assert.equal(memoryFeedback.kind, "incorrect");
  assert.equal(memoryFeedback.requestId, "req-abc");
  assert.equal(memoryFeedback.comment, "与最新说法矛盾");
  // Memory 无独立版本字段，用 governance.updatedAt 作为内容代次标识
  assert.equal(memoryFeedback.assetVersion, memoryUpdatedAt);

  const skillFeedback = service.submit({
    id: "fb-2",
    assetKind: "skill",
    assetId: "skill-1",
    scope,
    kind: "useful",
  });
  // Skill 版本关联版本号；requestId/comment 浏览场景可缺省
  assert.equal(skillFeedback.assetVersion, "1");
  assert.equal(skillFeedback.requestId, undefined);
  assert.equal(skillFeedback.comment, undefined);

  const listed = service.list(scope);
  assert.equal(listed.length, 2);
  assert.ok(FEEDBACK_KINDS.includes(listed[0]!.kind));
  repository.close();
});

test("反馈只落库，不改写资产状态或内容", () => {
  const repository = new SqliteRepository(":memory:");
  const service = new FeedbackService(repository);
  seedMemory(repository, "mem-1", "用户偏好中文");

  service.submit({
    id: "fb-1",
    assetKind: "memory",
    assetId: "mem-1",
    scope,
    kind: "outdated",
  });

  // 过期反馈是治理建议的输入，不得自动降级或改写资产
  const asset = repository.getMemory("mem-1")!;
  assert.equal(asset.governance.status, "verified");
  assert.equal(asset.content, "用户偏好中文");
  repository.close();
});

test("非法分类与未知资产被拒绝", () => {
  const repository = new SqliteRepository(":memory:");
  const service = new FeedbackService(repository);
  seedMemory(repository, "mem-1", "用户偏好中文");

  assert.throws(
    () => service.submit({ assetKind: "memory", assetId: "mem-1", scope, kind: "amazing" as FeedbackKind }),
    /kind must be one of/,
  );
  assert.throws(
    () => service.submit({ assetKind: "project" as never, assetId: "mem-1", scope, kind: "useful" }),
    /assetKind must be one of/,
  );
  assert.throws(
    () => service.submit({ assetKind: "memory", assetId: "missing", scope, kind: "useful" }),
    /memory not found/,
  );
  // 作用域外资产同样视为未命中
  assert.throws(
    () => service.submit({ assetKind: "memory", assetId: "mem-1", scope: otherScope, kind: "useful" }),
    /memory not found/,
  );
  repository.close();
});

test("反馈列表按作用域隔离且时间倒序", () => {
  const repository = new SqliteRepository(":memory:");
  let clock = 0;
  const service = new FeedbackService(repository, () => new Date(1_700_000_000_000 + clock++ * 1_000));
  seedMemory(repository, "mem-1", "用户偏好中文");
  seedMemory(repository, "mem-2", "用户在上海");

  service.submit({ id: "fb-1", assetKind: "memory", assetId: "mem-1", scope, kind: "useful" });
  service.submit({ id: "fb-2", assetKind: "memory", assetId: "mem-2", scope, kind: "irrelevant" });

  seedMemory(repository, "mem-other", "另一个作用域", otherScope);
  service.submit({ id: "fb-3", assetKind: "memory", assetId: "mem-other", scope: otherScope, kind: "useful" });

  const listed = service.list(scope);
  assert.deepEqual(listed.map((record) => record.id), ["fb-2", "fb-1"]);
  assert.equal(service.list(otherScope).length, 1);
  repository.close();
});

test("HTTP API 提交反馈并关联召回 requestId，未授权访问被拒绝", async () => {
  const repository = new SqliteRepository(":memory:");
  const memoryUpdatedAt = seedMemory(repository, "mem-http", "用户偏好中文");
  const accessKey = "feedback-http-test-key";
  const server = createMemorySkillsServer({ repository, accessKey });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const auth = { authorization: `Bearer ${accessKey}`, "content-type": "application/json" };

  try {
    // 先召回拿到 requestId：反馈要与具体一次召回请求关联
    const recall = await fetch(`${base}/v1/context/recall`, {
      method: "POST", headers: auth,
      body: JSON.stringify({ query: "用户偏好", scope }),
    });
    assert.equal(recall.status, 200);
    const requestId = ((await recall.json()) as { requestId: string }).requestId;

    const submitted = await fetch(`${base}/v1/feedback`, {
      method: "POST", headers: auth,
      body: JSON.stringify({ assetKind: "memory", assetId: "mem-http", scope, kind: "irrelevant", requestId }),
    });
    assert.equal(submitted.status, 200);
    const record = await submitted.json() as { kind: string; requestId: string; assetVersion: string };
    assert.equal(record.kind, "irrelevant");
    assert.equal(record.requestId, requestId);
    assert.equal(record.assetVersion, memoryUpdatedAt);

    const listed = await fetch(`${base}/v1/feedback/list`, {
      method: "POST", headers: auth,
      body: JSON.stringify({ scope }),
    });
    const items = ((await listed.json()) as { items: unknown[] }).items;
    assert.equal(items.length, 1);

    // 反馈 API 与其余 /v1/ 端点一致：必须携带 Access Key
    const unauthorized = await fetch(`${base}/v1/feedback`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ assetKind: "memory", assetId: "mem-http", scope, kind: "useful" }),
    });
    assert.equal(unauthorized.status, 401);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    repository.close();
  }
});
