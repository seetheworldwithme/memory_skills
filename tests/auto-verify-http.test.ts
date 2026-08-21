import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";

import { createMemorySkillsServer } from "../src/api/http-server.js";
import { AuthService } from "../src/auth/auth-service.js";
import { sha256Hex } from "../src/auth/access-key.js";
import { MockLlmProvider, type MockLlmStep } from "../src/llm/mock-provider.js";
import { SqliteRepository } from "../src/storage/sqlite-repository.js";
import { SqliteVectorIndex } from "../src/retrieval/vector-index.js";
import type { EmbeddingProvider, EmbeddingRequest, EmbeddingResult } from "../src/retrieval/types.js";
import type { ObservabilityEvent } from "../src/observability/events.js";
import type { Scope } from "../src/governance/types.js";

const scope: Scope = { userId: "u1", teamId: "t1", agentId: "a1" };
const accessKey = "auto-verify-http-key";

/** 可控 Embedding Provider：向量通道就绪，用于断言自动 Verify 后的自动向量同步。 */
class FakeEmbeddingProvider implements EmbeddingProvider {
  readonly name = "fake";
  readonly model = "fake-embedding";

  async embed(request: EmbeddingRequest): Promise<EmbeddingResult> {
    return {
      vectors: request.texts.map(() => [0.1, 0.2, 0.3, 0.4]),
      model: this.model,
      latencyMs: 0,
      attempts: 1,
    };
  }
}

/** 收集型事件 sink：断言 governance.auto_verify.evaluated 等事件的载体。 */
class CollectingEventSink {
  readonly events: ObservabilityEvent[] = [];
  emit(event: ObservabilityEvent): void {
    this.events.push(event);
  }
}

/** 与生产缺省一致的已开启配置。 */
const enabledConfig = {
  enabled: true,
  minConfidence: 0.8,
  layers: ["l1" as const],
  allowedEvidenceRoles: ["user" as const],
  minOverlap: 0.8,
  requireMultiSession: false,
};

interface TestContext {
  base: string;
  repository: SqliteRepository;
  index: SqliteVectorIndex;
  events: CollectingEventSink;
  close: () => Promise<void>;
}

async function startServer(steps: readonly MockLlmStep[], options?: { autoVerify?: boolean; readerToken?: string }): Promise<TestContext> {
  const repository = new SqliteRepository(":memory:");
  const index = new SqliteVectorIndex("fake-embedding", ":memory:");
  const events = new CollectingEventSink();
  const { AuditService } = await import("../src/security/audit-service.js");
  const server = createMemorySkillsServer({
    repository,
    accessKey,
    ...(options?.readerToken
      ? {
        authService: new AuthService({
          accessKey,
          teamTokens: [{
            id: "reader-token",
            tokenHash: sha256Hex(options.readerToken),
            userId: "reader-user",
            teamId: "t1",
            roles: ["reader"],
          }],
        }),
      }
      : {}),
    security: { audit: new AuditService(events) },
    eventSink: events,
    llmProvider: new MockLlmProvider({ steps, model: "mock-model" }),
    embedding: { provider: new FakeEmbeddingProvider(), index },
    ...(options?.autoVerify === false ? {} : { autoVerify: enabledConfig }),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    base,
    repository,
    index,
    events,
    close: async () => {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      index.close();
      repository.close();
    },
  };
}

async function post(url: string, body: unknown, token = accessKey): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function captureEvidence(base: string, content: string, id: string): Promise<string> {
  const response = await post(`${base}/v1/evidence`, { id, scope, role: "user", content });
  assert.equal(response.status, 200, await response.text());
  return id;
}

test("HTTP：提案运行后忠实抽取的 Draft 被规则自动 Verify，事件与向量同步齐备", async () => {
  const context = await startServer([{
    type: "ok",
    data: {
      candidates: [
        { layer: "l1", content: "以后所有代码注释一律用中文写", confidence: 0.9, reason: "明确偏好", evidenceRefs: [1] },
      ],
    },
  }]);
  try {
    await captureEvidence(context.base, "以后所有代码注释一律用中文写。", "ev-verbatim");

    const response = await post(`${context.base}/v1/proposals/memory/run`, { scope });
    const report = await response.json() as {
      autoVerifiedIds?: string[];
      created: Array<{ id: string; governance: { status: string; verifiedBy?: string } }>;
    };
    assert.equal(response.status, 200);
    assert.equal(report.created.length, 1);
    // 响应中的资产状态已刷新为 verified，且带 autoVerifiedIds 与 verifiedBy=auto
    assert.equal(report.created[0]!.governance.status, "verified");
    assert.equal(report.created[0]!.governance.verifiedBy, "auto");
    assert.deepEqual(report.autoVerifiedIds, [report.created[0]!.id]);

    // 评估事件 + 状态变更审计（trigger=proposal.auto_verify）+ 自动向量同步
    const evaluated = context.events.events.filter((event) => event.eventType === "governance.auto_verify.evaluated");
    assert.equal(evaluated.length, 1);
    assert.equal(evaluated[0]!.passed, true);
    const stateChanged = context.events.events
      .filter((event) => event.eventType === "audit.state_changed")
      .find((event) => event.trigger === "proposal.auto_verify");
    assert.ok(stateChanged, "缺少 proposal.auto_verify 状态变更审计");
    assert.ok(context.events.events.some((event) => event.eventType === "retrieval.auto_sync.completed"));
    // 向量通道已就绪：自动 Verify 的资产无需手动同步即可进入 hybrid 检索
    const fingerprints = await context.index.fingerprints(scope, "memory");
    assert.deepEqual(fingerprints.map((entry) => entry.assetId), [report.created[0]!.id]);
  } finally {
    await context.close();
  }
});

test("HTTP：模型改写的 Draft 不被放行，评估事件携带规则码", async () => {
  const context = await startServer([{
    type: "ok",
    data: {
      candidates: [
        { layer: "l1", content: "同义改写的另一句话", confidence: 0.9, reason: "改写", evidenceRefs: [1] },
      ],
    },
  }]);
  try {
    await captureEvidence(context.base, "证据原文内容足够长。", "ev-rewritten");

    const response = await post(`${context.base}/v1/proposals/memory/run`, { scope });
    const report = await response.json() as {
      autoVerifiedIds?: string[];
      created: Array<{ id: string; governance: { status: string } }>;
    };
    assert.equal(response.status, 200);
    assert.equal(report.created[0]!.governance.status, "draft");
    assert.equal(report.autoVerifiedIds, undefined);

    const evaluated = context.events.events
      .filter((event) => event.eventType === "governance.auto_verify.evaluated");
    assert.equal(evaluated.length, 1);
    assert.equal(evaluated[0]!.passed, false);
    assert.deepEqual(evaluated[0]!.ruleCodes, ["low_overlap"]);
  } finally {
    await context.close();
  }
});

test("HTTP：Skill 提案永不自动 Verify；规则未开启时 memory 提案也只产 Draft", async () => {
  const skillCandidate = {
    candidates: [{
      name: "verify-before-merge",
      description: "合并前执行完整验证流程",
      content: "---\nname: verify-before-merge\ndescription: 合并前执行完整验证流程\n---\n\n# Skill\n\n## 工作流\n\n1. 运行 npm test；\n2. 全部通过后合并。\n\n## 验证方式\n\n确认命令退出码为 0。\n",
      evidenceRefs: [1],
    }],
  };

  // Skill：规则开启也不放行（kind_not_supported）
  const skillContext = await startServer([{ type: "ok", data: skillCandidate }]);
  try {
    await captureEvidence(skillContext.base, "部署前先跑 npm test，全绿才合并。", "ev-skill");
    const response = await post(`${skillContext.base}/v1/proposals/skill/run`, { scope });
    const report = await response.json() as {
      autoVerifiedIds?: string[];
      created: Array<{ id: string; status: string }>;
    };
    assert.equal(response.status, 200);
    assert.equal(report.created[0]!.status, "draft");
    assert.equal(report.autoVerifiedIds, undefined);
    assert.ok(!skillContext.events.events.some((event) => event.eventType === "governance.auto_verify.evaluated"));
  } finally {
    await skillContext.close();
  }

  // memory：规则关闭时即使忠实抽取也只产 Draft
  const offContext = await startServer([{
    type: "ok",
    data: { candidates: [{ layer: "l1", content: "以后所有代码注释一律用中文写", confidence: 0.9, reason: "明确偏好", evidenceRefs: [1] }] },
  }], { autoVerify: false });
  try {
    await captureEvidence(offContext.base, "以后所有代码注释一律用中文写。", "ev-off");
    const response = await post(`${offContext.base}/v1/proposals/memory/run`, { scope });
    const report = await response.json() as {
      autoVerifiedIds?: string[];
      created: Array<{ governance: { status: string } }>;
    };
    assert.equal(response.status, 200);
    assert.equal(report.created[0]!.governance.status, "draft");
    assert.equal(report.autoVerifiedIds, undefined);
  } finally {
    await offContext.close();
  }
});

test("HTTP：无写入权限的身份不能触发提案；批量复评端点补评现存 Draft", async () => {
  const readerToken = "reader-token-value";
  const context = await startServer([{
    type: "ok",
    data: { candidates: [{ layer: "l1", content: "同义改写的另一句话", confidence: 0.9, reason: "改写", evidenceRefs: [1] }] },
  }], { readerToken });
  try {
    await captureEvidence(context.base, "证据原文内容足够长。", "ev-reader");

    // reader 无 write 权限：提案端点 403，不存在借提案间接发布的通道
    const forbidden = await post(`${context.base}/v1/proposals/memory/run`, { scope }, readerToken);
    assert.equal(forbidden.status, 403);

    // 造一条 Draft（admin 触发提案，改写内容不会被规则放行）
    const response = await post(`${context.base}/v1/proposals/memory/run`, { scope });
    const report = await response.json() as { created: Array<{ id: string }> };
    assert.equal(report.created.length, 1);

    // reader 也不能调用批量复评（review 权限）
    const denied = await post(`${context.base}/v1/proposals/memory/auto-verify`, { scope }, readerToken);
    assert.equal(denied.status, 403);

    // admin 批量复评：仍不通过的 Draft 返回规则码，不产生状态变更
    const review = await post(`${context.base}/v1/proposals/memory/auto-verify`, { scope });
    const results = await review.json() as { results: Array<{ id: string; passed: boolean; ruleCodes: string[] }> };
    assert.equal(review.status, 200);
    assert.equal(results.results.length, 1);
    assert.equal(results.results[0]!.passed, false);
    assert.deepEqual(results.results[0]!.ruleCodes, ["low_overlap"]);
  } finally {
    await context.close();
  }
});

test("HTTP：批量复评放行符合条件的现存 Draft，并带完整事件与向量同步", async () => {
  const context = await startServer([]);
  try {
    const evidenceId = await captureEvidence(context.base, "用户偏好中文注释。", "ev-batch");
    // 直接经 /v1/memories 造 Draft（不走模型），再由批量复评端点放行
    const create = await post(`${context.base}/v1/memories`, {
      id: "mem-batch", layer: "l1", scope, content: "用户偏好中文注释",
      confidence: 0.9, reason: "批量复评测试", sourceEvidenceIds: [evidenceId],
    });
    assert.equal(create.status, 200);

    const review = await post(`${context.base}/v1/proposals/memory/auto-verify`, { scope });
    const results = await review.json() as { results: Array<{ id: string; passed: boolean }> };
    assert.equal(review.status, 200);
    assert.deepEqual(results.results, [{ id: "mem-batch", passed: true, ruleCodes: [] }]);
    assert.ok(context.events.events.some((event) => event.eventType === "governance.auto_verify.evaluated"));
    assert.ok(context.events.events.some((event) => event.eventType === "retrieval.auto_sync.completed"));
    const fingerprints = await context.index.fingerprints(scope, "memory");
    assert.deepEqual(fingerprints.map((entry) => entry.assetId), ["mem-batch"]);
  } finally {
    await context.close();
  }
});

test("HTTP：显式 evidenceIds 的提案（SessionEnd hook 调用形态）同样走自动 Verify", async () => {
  const context = await startServer([{
    type: "ok",
    data: { candidates: [{ layer: "l1", content: "以后所有代码注释一律用中文写", confidence: 0.9, reason: "明确偏好", evidenceRefs: [1] }] },
  }]);
  try {
    const evidenceId = await captureEvidence(context.base, "以后所有代码注释一律用中文写。", "ev-hook");
    const response = await post(`${context.base}/v1/proposals/memory/run`, { scope, evidenceIds: [evidenceId] });
    const report = await response.json() as {
      autoVerifiedIds?: string[];
      created: Array<{ id: string; governance: { status: string; verifiedBy?: string } }>;
    };
    assert.equal(response.status, 200);
    assert.equal(report.created[0]!.governance.status, "verified");
    assert.equal(report.created[0]!.governance.verifiedBy, "auto");
    assert.deepEqual(report.autoVerifiedIds, [report.created[0]!.id]);
  } finally {
    await context.close();
  }
});

test("HTTP：evidence 上报 originSessionId 并在读取时原样返回（迁移 005 列生效）", async () => {
  const context = await startServer([]);
  try {
    const created = await post(`${context.base}/v1/evidence`, {
      id: "ev-origin", scope, role: "user", content: "证据原文。", originSessionId: "claude-session-abc",
    });
    assert.equal(created.status, 200);

    const fetched = await post(`${context.base}/v1/evidence/get`, { scope, ids: ["ev-origin"] });
    const body = await fetched.json() as { items: Array<{ id: string; originSessionId?: string }> };
    assert.equal(fetched.status, 200);
    assert.equal(body.items[0]!.originSessionId, "claude-session-abc");
  } finally {
    await context.close();
  }
});
