import assert from "node:assert/strict";
import test from "node:test";

import {
  contentOverlap,
  evaluateAutoVerify,
  resolveAutoVerifyConfigFromEnv,
  shouldAutoDeprecateFromFeedback,
  type AutoVerifyConfig,
} from "../src/governance/auto-verify.js";
import { AutoVerifyService } from "../src/governance/auto-verify-service.js";
import { MemoryService } from "../src/memory/memory-service.js";
import { SqliteRepository } from "../src/storage/sqlite-repository.js";
import type { Evidence } from "../src/memory/types.js";
import type { GovernanceMetadata } from "../src/governance/types.js";
import type { Scope } from "../src/governance/types.js";

const scope: Scope = { userId: "auto-verify-user", teamId: "team-av", agentId: "agent-av" };

/** 测试默认配置：与生产缺省一致（l1 / user 原话 / 置信 0.8 / 重合 0.8）。 */
const defaultConfig: AutoVerifyConfig & { enabled: true } = {
  enabled: true,
  minConfidence: 0.8,
  layers: ["l1"],
  allowedEvidenceRoles: ["user"],
  minOverlap: 0.8,
  requireMultiSession: false,
};

test("contentOverlap：中文逐字引用覆盖率为 1，同义改写显著低于阈值，标点空白不影响", () => {
  const evidence = ["以后所有代码注释一律用中文写。"];
  // 忠实抽取（仅去标点）：覆盖率应为 1
  assert.equal(contentOverlap("以后所有代码注释一律用中文写", evidence), 1);
  // 同义改写（模型发挥）：覆盖率显著低于 0.8
  assert.ok(contentOverlap("用户希望注释使用中文", evidence) < 0.8);
  // 空白与标点差异不影响判定
  assert.equal(contentOverlap("以后所有代码注释一律用中文写！", ["以后 所有 代码注释 一律用中文 写。"]), 1);
  // 英文逐字引用同样成立
  assert.ok(contentOverlap("Always show verification evidence", ["rule: Always show verification evidence"]) >= 0.8);
  // 归一化后不足 2 字符按 0 处理（失败安全）
  assert.equal(contentOverlap("a", evidence), 0);
  // 无证据按 0 处理
  assert.equal(contentOverlap("任意内容", []), 0);
});

test("evaluateAutoVerify：全规则通过的候选放行", () => {
  const evidence: Evidence[] = [{
    id: "ev-1", scope, role: "user", content: "以后所有代码注释一律用中文写。", capturedAt: "2026-08-21T00:00:00Z",
  }];
  const result = evaluateAutoVerify(defaultConfig, {
    kind: "memory",
    layer: "l1",
    confidence: 0.9,
    sensitivity: "normal",
    content: "以后所有代码注释一律用中文写",
    evidence,
  });
  assert.deepEqual(result, { passed: true, ruleCodes: [] });
});

test("evaluateAutoVerify：各否决规则返回正确规则码", () => {
  const userEvidence: Evidence[] = [{
    id: "ev-1", scope, role: "user", content: "证据原文内容足够长。", capturedAt: "2026-08-21T00:00:00Z",
  }];
  const base = { kind: "memory", layer: "l1", confidence: 0.9, sensitivity: "normal", content: "证据原文内容足够长", evidence: userEvidence } as const;

  // v1 Skill 永不自动 Verify
  assert.deepEqual(evaluateAutoVerify(defaultConfig, { ...base, kind: "skill" }), { passed: false, ruleCodes: ["kind_not_supported"] });
  // 敏感资产不放行
  assert.deepEqual(evaluateAutoVerify(defaultConfig, { ...base, sensitivity: "sensitive" }).ruleCodes, ["sensitivity_not_normal"]);
  // l2/l3 归纳层不放行
  assert.deepEqual(evaluateAutoVerify(defaultConfig, { ...base, layer: "l2" }).ruleCodes, ["layer_not_allowed"]);
  // 低置信不放行
  assert.deepEqual(evaluateAutoVerify(defaultConfig, { ...base, confidence: 0.6 }).ruleCodes, ["low_confidence"]);
  // assistant 证据混入不放行
  assert.deepEqual(
    evaluateAutoVerify(defaultConfig, { ...base, evidence: [...userEvidence, { ...userEvidence[0]!, id: "ev-2", role: "assistant" }] }).ruleCodes,
    ["evidence_role_not_allowed"],
  );
  // 与证据原文重合度过低（模型改写）不放行
  assert.deepEqual(evaluateAutoVerify(defaultConfig, { ...base, content: "同义改写的另一句话" }).ruleCodes, ["low_overlap"]);
  // 无来源证据：角色与重合度规则同时否决
  assert.deepEqual(evaluateAutoVerify(defaultConfig, { ...base, evidence: [] }).ruleCodes, ["evidence_role_not_allowed", "low_overlap"]);
});

test("evaluateAutoVerify：多会话佐证规则按 originSessionId 去重计数", () => {
  const config: AutoVerifyConfig & { enabled: true } = { ...defaultConfig, requireMultiSession: true };
  const evidence = (sessionId?: string, id = "ev-x"): Evidence => ({
    id, scope, role: "user", content: "用户偏好中文注释。", capturedAt: "2026-08-21T00:00:00Z",
    ...(sessionId === undefined ? {} : { originSessionId: sessionId }),
  });
  const input = { kind: "memory", layer: "l1", confidence: 0.9, sensitivity: "normal", content: "用户偏好中文注释", evidence: [] as Evidence[] } as const;

  // 单会话（两个证据同一 originSessionId）→ 否决
  const single = evaluateAutoVerify(config, { ...input, evidence: [evidence("s1", "ev-1"), evidence("s1", "ev-2")] });
  assert.deepEqual(single, { passed: false, ruleCodes: ["single_session"] });
  // 两个独立会话 → 通过
  const multi = evaluateAutoVerify(config, { ...input, evidence: [evidence("s1", "ev-3"), evidence("s2", "ev-4")] });
  assert.deepEqual(multi, { passed: true, ruleCodes: [] });
});

test("AutoVerifyService.verifyCreated：忠实抽取的 Draft 被放行并标记 verifiedBy=auto", () => {
  const repository = new SqliteRepository(":memory:");
  const memory = new MemoryService(repository, () => new Date("2026-08-21T00:00:00Z"));
  const evidence = memory.capture({ id: "ev-1", scope, role: "user", content: "以后所有代码注释一律用中文写。" });
  const draft = memory.propose({
    id: "mem-1", layer: "l1", scope, content: "以后所有代码注释一律用中文写",
    confidence: 0.9, reason: "明确偏好", sourceEvidenceIds: [evidence.id],
  });

  const service = new AutoVerifyService({ memory, repository, config: defaultConfig });
  const results = service.verifyCreated(scope, [draft]);

  assert.deepEqual(results, [{ id: "mem-1", passed: true, ruleCodes: [] }]);
  const verified = memory.get("mem-1", scope)!;
  assert.equal(verified.governance.status, "verified");
  assert.equal(verified.governance.verifiedBy, "auto");
  assert.ok(verified.governance.lastVerifiedAt);
});

test("AutoVerifyService.verifyCreated：改写 Draft 留在 Draft 且返回规则码；失败安全不抛异常", () => {
  const repository = new SqliteRepository(":memory:");
  const memory = new MemoryService(repository, () => new Date("2026-08-21T00:00:00Z"));
  const evidence = memory.capture({ id: "ev-1", scope, role: "user", content: "证据原文内容足够长。" });
  const rewritten = memory.propose({
    id: "mem-rewritten", layer: "l1", scope, content: "同义改写的另一句话",
    confidence: 0.9, reason: "改写", sourceEvidenceIds: [evidence.id],
  });
  // 来源悬空的 Draft：Draft 阶段删除来源证据（传播只影响 Verified），
  // sources 仍引用已消失的证据——评估不抛异常，由规则否决
  const danglingEvidence = memory.capture({ id: "ev-2", scope, role: "user", content: "悬空证据原文。" });
  const dangling = memory.propose({
    id: "mem-dangling", layer: "l1", scope, content: "悬空来源的内容",
    confidence: 0.9, reason: "悬空", sourceEvidenceIds: [danglingEvidence.id],
  });
  memory.deleteEvidence(danglingEvidence.id, scope);

  const service = new AutoVerifyService({ memory, repository, config: defaultConfig });
  const results = service.verifyCreated(scope, [rewritten, dangling]);

  assert.equal(results[0]!.passed, false);
  assert.deepEqual(results[0]!.ruleCodes, ["low_overlap"]);
  assert.equal(results[1]!.passed, false);
  assert.ok(results[1]!.ruleCodes.includes("low_overlap"));
  assert.equal(memory.get("mem-rewritten", scope)!.governance.status, "draft");
  assert.equal(memory.get("mem-dangling", scope)!.governance.status, "draft");
});

test("AutoVerifyService.evaluateDrafts：批量复评现存 Draft，非 Draft 资产不动", () => {
  const repository = new SqliteRepository(":memory:");
  const memory = new MemoryService(repository, () => new Date("2026-08-21T00:00:00Z"));
  const evidence = memory.capture({ id: "ev-1", scope, role: "user", content: "用户偏好中文注释。" });
  memory.propose({ id: "mem-draft", layer: "l1", scope, content: "用户偏好中文注释", confidence: 0.9, reason: "偏好", sourceEvidenceIds: [evidence.id] });
  memory.propose({ id: "mem-rejected", layer: "l1", scope, content: "另一条待拒内容", confidence: 0.9, reason: "测试", sourceEvidenceIds: [evidence.id] });
  memory.transition("mem-rejected", scope, "rejected");

  const service = new AutoVerifyService({ memory, repository, config: defaultConfig });
  const results = service.evaluateDrafts(scope);

  assert.equal(results.length, 1);
  assert.equal(results[0]!.id, "mem-draft");
  assert.equal(results[0]!.passed, true);
  assert.equal(memory.get("mem-rejected", scope)!.governance.status, "rejected");
});

test("resolveAutoVerifyConfigFromEnv：缺省/非法取值一律降级关闭（失败安全）", () => {
  // 缺省与未启用
  assert.deepEqual(resolveAutoVerifyConfigFromEnv({}), { enabled: false });
  assert.deepEqual(resolveAutoVerifyConfigFromEnv({ MEMORY_SKILLS_AUTO_VERIFY: "off" }), { enabled: false });
  assert.deepEqual(resolveAutoVerifyConfigFromEnv({ MEMORY_SKILLS_AUTO_VERIFY: "yes" }), { enabled: false });

  // 开启 + 全部缺省值
  const config = resolveAutoVerifyConfigFromEnv({ MEMORY_SKILLS_AUTO_VERIFY: "rules" });
  assert.deepEqual(config, {
    enabled: true, minConfidence: 0.8, layers: ["l1"], allowedEvidenceRoles: ["user"], minOverlap: 0.8, requireMultiSession: false,
  });

  // 自定义合法值
  const custom = resolveAutoVerifyConfigFromEnv({
    MEMORY_SKILLS_AUTO_VERIFY: "rules",
    MEMORY_SKILLS_AUTO_VERIFY_MIN_CONFIDENCE: "0.7",
    MEMORY_SKILLS_AUTO_VERIFY_LAYERS: "l1,l2",
    MEMORY_SKILLS_AUTO_VERIFY_EVIDENCE_ROLES: "user,tool",
    MEMORY_SKILLS_AUTO_VERIFY_MIN_OVERLAP: "0.9",
    MEMORY_SKILLS_AUTO_VERIFY_REQUIRE_MULTI_SESSION: "1",
  });
  assert.deepEqual(custom, {
    enabled: true, minConfidence: 0.7, layers: ["l1", "l2"], allowedEvidenceRoles: ["user", "tool"], minOverlap: 0.9, requireMultiSession: true,
  });

  // 非法阈值/列表：整体回退缺省（不因配置错误放行更宽松的规则）
  assert.deepEqual(resolveAutoVerifyConfigFromEnv({ MEMORY_SKILLS_AUTO_VERIFY: "rules", MEMORY_SKILLS_AUTO_VERIFY_MIN_CONFIDENCE: "abc" }), config);
  assert.deepEqual(resolveAutoVerifyConfigFromEnv({ MEMORY_SKILLS_AUTO_VERIFY: "rules", MEMORY_SKILLS_AUTO_VERIFY_MIN_OVERLAP: "1.5" }), config);
  assert.deepEqual(resolveAutoVerifyConfigFromEnv({ MEMORY_SKILLS_AUTO_VERIFY: "rules", MEMORY_SKILLS_AUTO_VERIFY_LAYERS: "l9" }), config);
  assert.deepEqual(resolveAutoVerifyConfigFromEnv({ MEMORY_SKILLS_AUTO_VERIFY: "rules", MEMORY_SKILLS_AUTO_VERIFY_EVIDENCE_ROLES: "model" }), config);
});

test("shouldAutoDeprecateFromFeedback：仅 auto-verified 资产的 incorrect/outdated 反馈触发降级", () => {
  const base: GovernanceMetadata = {
    status: "verified", confidence: 0.9, createdReason: "测试", createdAt: "2026-08-21T00:00:00Z",
    updatedAt: "2026-08-21T00:00:00Z", sensitivity: "normal", verifiedBy: "auto",
  };
  // auto + incorrect/outdated → 允许降级
  assert.equal(shouldAutoDeprecateFromFeedback(base, "incorrect"), true);
  assert.equal(shouldAutoDeprecateFromFeedback(base, "outdated"), true);
  // useful/irrelevant 不触发
  assert.equal(shouldAutoDeprecateFromFeedback(base, "useful"), false);
  assert.equal(shouldAutoDeprecateFromFeedback(base, "irrelevant"), false);
  // 人工 Verify（无 verifiedBy 标记）不触发
  const { verifiedBy: _omit, ...manual } = base;
  assert.equal(shouldAutoDeprecateFromFeedback(manual, "incorrect"), false);
  // 已非 verified（重复反馈）不触发：天然幂等
  const deprecated: GovernanceMetadata = { ...base, status: "deprecated" };
  assert.equal(shouldAutoDeprecateFromFeedback(deprecated, "incorrect"), false);
});
