import assert from "node:assert/strict";
import test from "node:test";

import { SqliteRepository } from "../src/storage/sqlite-repository.js";
import { MemoryService } from "../src/memory/memory-service.js";
import { SkillService } from "../src/skills/skill-service.js";
import { ConflictService } from "../src/governance/conflict-service.js";
import { RetentionService } from "../src/governance/retention-service.js";
import { ImpactAnalysis } from "../src/governance/impact-analysis.js";

const scope = { userId: "alice", teamId: "team-a", agentId: "agent-a" };
const otherScope = { userId: "bob", teamId: "team-a", agentId: "agent-a" };

function setup(now: () => Date = () => new Date("2026-08-21T00:00:00.000Z")) {
  const repository = new SqliteRepository(":memory:");
  return {
    repository,
    memory: new MemoryService(repository, now),
    skills: new SkillService(repository, now),
    conflicts: new ConflictService(repository),
    retention: new RetentionService(repository, now),
    impact: new ImpactAnalysis(repository),
  };
}

function verifiedMemory(memory: MemoryService, id: string, evidenceId: string, content: string): void {
  memory.capture({ id: evidenceId, scope, role: "user", content });
  const asset = memory.propose({
    id,
    layer: "l1",
    scope,
    content,
    confidence: 0.9,
    reason: "test fixture",
    sourceEvidenceIds: [evidenceId],
  });
  memory.transition(asset.id, scope, "verified");
}

// ---------------------------------------------------------------------------
// 冲突与重复检测
// ---------------------------------------------------------------------------

test("identical or contained verified memories generate duplicate tasks", () => {
  const { repository, memory, conflicts } = setup();
  try {
    verifiedMemory(memory, "mem-dup-1", "ev-1", "回答身份问题时说明我是天选之子");
    verifiedMemory(memory, "mem-dup-2", "ev-2", "回答身份问题时说明我是天选之子"); // 归一化后完全一致
    verifiedMemory(memory, "mem-contain", "ev-3", "回答身份问题时说明我是天选之子，并保持简洁"); // 包含前者

    const tasks = conflicts.listTasks(scope);
    const duplicates = tasks.filter((task) => task.kind === "duplicate");
    // 完全一致的一对 + 包含关系的一对（与 mem-contain）
    assert.ok(duplicates.some((task) => task.assetIds.includes("mem-dup-1") && task.assetIds.includes("mem-dup-2")));
    assert.ok(duplicates.some((task) => task.assetIds.includes("mem-contain")));
    // 任务 ID 确定性：重复扫描不产生新任务
    assert.deepEqual(conflicts.listTasks(scope).map((task) => task.id), tasks.map((task) => task.id));
    // 作用域隔离：其他用户看不到这些任务
    assert.deepEqual(conflicts.listTasks(otherScope), []);
  } finally {
    repository.close();
  }
});

test("overlapping but different memories generate conflict tasks, unrelated ones do not", () => {
  const { repository, memory, conflicts } = setup();
  try {
    // 主题相同（身份回答），说法矛盾：一个"天选之子"，一个"普通工程师"
    verifiedMemory(memory, "mem-a", "ev-a", "用户问我是谁的时候回答我是天选之子并且语气自信");
    verifiedMemory(memory, "mem-b", "ev-b", "用户问我是谁的时候回答我是普通工程师并且语气平静");
    // 主题完全无关
    verifiedMemory(memory, "mem-c", "ev-c", "项目使用 SQLite 存储所有本地数据并通过 WAL 提升并发读性能");

    const tasks = conflicts.listTasks(scope);
    const conflict = tasks.find((task) => task.kind === "conflict");
    assert.ok(conflict, "应检出一条疑似冲突任务");
    assert.deepEqual([...conflict!.assetIds].sort(), ["mem-a", "mem-b"]);
    assert.ok(conflict!.suggestion.length > 0);
    // 无关资产不进任务
    assert.ok(tasks.every((task) => !task.assetIds.includes("mem-c")));
  } finally {
    repository.close();
  }
});

test("draft assets never enter conflict scan and duplicates can be resolved by governance", () => {
  const { repository, memory, conflicts } = setup();
  try {
    verifiedMemory(memory, "mem-x", "ev-x", "部署服务时先跑完整回归再发布");
    verifiedMemory(memory, "mem-y", "ev-y", "部署服务时先跑完整回归再发布");
    assert.equal(conflicts.listTasks(scope).filter((task) => task.kind === "duplicate").length, 1);

    // 处置其中一条（把重复项降权待复核）后，任务在下次扫描中消失
    memory.transition("mem-y", scope, "deprecated");
    assert.deepEqual(conflicts.listTasks(scope), []);
  } finally {
    repository.close();
  }
});

test("duplicate verified skills generate tasks scoped per kind", () => {
  const { repository, memory, skills, conflicts } = setup();
  try {
    memory.capture({ id: "ev-s", scope, role: "user", content: "skill evidence" });
    const content = "---\nname: deploy-fast\ndescription: 快速部署\n---\n\n# Workflow\n1. 直接部署";
    const first = skills.create({ id: "skill-a", scope, name: "deploy-fast", description: "快速部署", content, sourceEvidenceIds: ["ev-s"] });
    const second = skills.create({ id: "skill-b", scope, name: "deploy-slow", description: "慢速部署", content: "---\nname: deploy-slow\ndescription: 慢速部署\n---\n\n# Workflow\n1. 直接部署", sourceEvidenceIds: ["ev-s"] });
    skills.transition(first.id, scope, "verified");
    skills.transition(second.id, scope, "verified");

    const tasks = conflicts.listTasks(scope);
    const skillTask = tasks.find((task) => task.assetKind === "skill" && task.kind === "duplicate");
    assert.ok(skillTask, "内容重复的 Skill 应生成重复任务");
    assert.deepEqual([...skillTask!.assetIds].sort(), ["skill-a", "skill-b"]);
    assert.ok(skillTask!.assets.every((asset) => asset.name !== undefined));
  } finally {
    repository.close();
  }
});

// ---------------------------------------------------------------------------
// 删除影响分析与传播
// ---------------------------------------------------------------------------

test("evidence deletion impact preview lists derived assets without changing anything", () => {
  const { repository, memory, skills, impact } = setup();
  try {
    memory.capture({ id: "ev-del", scope, role: "user", content: "一段需要被删除的证据原文，长度足够生成预览。" });
    const asset = memory.propose({
      id: "mem-del", layer: "l1", scope,
      content: "派生记忆：发布前必须完整回归",
      confidence: 0.9, reason: "fixture", sourceEvidenceIds: ["ev-del"],
    });
    memory.transition(asset.id, scope, "verified");
    const skill = skills.create({
      id: "skill-del", scope, name: "release-guard", description: "发布守卫",
      content: "---\nname: release-guard\ndescription: 发布守卫\n---\n\n# Workflow\n1. 回归",
      sourceEvidenceIds: ["ev-del"],
    });
    skills.transition(skill.id, scope, "verified");

    const preview = impact.evidenceDeletion("ev-del", scope);
    assert.equal(preview.evidence.id, "ev-del");
    assert.equal(preview.pendingReviewCount, 2);
    assert.deepEqual(preview.memories, [{
      id: "mem-del", status: "verified", contentPreview: "派生记忆：发布前必须完整回归", wouldTransitionTo: "deprecated",
    }]);
    assert.equal(preview.skills[0]!.id, "skill-del");
    assert.equal(preview.skills[0]!.wouldTransitionTo, "deprecated");

    // 预览是只读的：资产状态不变
    assert.equal(memory.get("mem-del", scope)?.governance.status, "verified");
    // 不存在的证据返回 404 语义错误
    assert.throws(() => impact.evidenceDeletion("ev-missing", scope), /evidence not found/);
  } finally {
    repository.close();
  }
});

test("deleting evidence deprecates verified assets and keeps drafts untouched", () => {
  const { repository, memory, skills } = setup();
  try {
    memory.capture({ id: "ev-p", scope, role: "user", content: "evidence for propagation" });
    const verified = memory.propose({
      id: "mem-verified", layer: "l1", scope,
      content: "已验证记忆", confidence: 0.9, reason: "fixture", sourceEvidenceIds: ["ev-p"],
    });
    memory.transition(verified.id, scope, "verified");
    const draft = memory.propose({
      id: "mem-draft", layer: "l1", scope,
      content: "草稿记忆", confidence: 0.9, reason: "fixture", sourceEvidenceIds: ["ev-p"],
    });

    const result = memory.deleteEvidence("ev-p", scope);
    assert.deepEqual(result.memories, [
      { id: "mem-draft", from: "draft", to: "draft" },
      { id: "mem-verified", from: "verified", to: "deprecated" },
    ]);
    assert.equal(memory.get("mem-verified", scope)?.governance.status, "deprecated");
    assert.equal(memory.get("mem-draft", scope)?.governance.status, "draft");
    // 证据本身已删除，来源悬空在 Validate 时暴露
    assert.equal(memory.recall({ query: "已验证记忆", scope }).length, 0);
  } finally {
    repository.close();
  }
});

// ---------------------------------------------------------------------------
// 过期与保留策略
// ---------------------------------------------------------------------------

test("expired verified memories are listed for review and never physically deleted", () => {
  const { repository, memory, retention } = setup();
  try {
    verifiedMemory(memory, "mem-exp", "ev-exp", "只在短期内有效的临时偏好设置");
    memory.capture({ id: "ev-fresh", scope, role: "user", content: "fresh fact" });
    const fresh = memory.propose({
      id: "mem-fresh", layer: "l1", scope,
      content: "没有过期时间的长期事实", confidence: 0.9, reason: "fixture", sourceEvidenceIds: ["ev-fresh"],
    });
    memory.transition(fresh.id, scope, "verified");

    // 设置一个已过去的有效期：直接更新治理元数据模拟到期
    repository.updateMemoryValidity("mem-exp", { validUntil: "2026-08-01T00:00:00.000Z" }, "2026-07-01T00:00:00.000Z");

    const review = retention.review(scope);
    assert.deepEqual(review.expiredMemories.map((item) => item.id), ["mem-exp"]);
    assert.equal(review.expiredMemories[0]!.validUntil, "2026-08-01T00:00:00.000Z");
    // 长期事实不属于过期清单
    assert.ok(review.expiredMemories.every((item) => item.id !== "mem-fresh"));

    // 降权：Verified → Deprecated（待复核），资产仍存在，没有任何物理删除
    const sweep = retention.deprecateExpired(scope);
    assert.deepEqual(sweep.memories, [{ id: "mem-exp", from: "verified", to: "deprecated" }]);
    const after = memory.get("mem-exp", scope);
    assert.equal(after?.governance.status, "deprecated");
    assert.equal(after?.content, "只在短期内有效的临时偏好设置");
    // 重复执行是幂等的（已不是 verified）
    assert.deepEqual(retention.deprecateExpired(scope), { memories: [] });
    assert.deepEqual(retention.review(scope).expiredMemories, []);
  } finally {
    repository.close();
  }
});

test("renewing an expired-deprecated memory restores it to verified", () => {
  const { repository, memory, retention } = setup();
  try {
    verifiedMemory(memory, "mem-renew", "ev-renew", "用户确认仍然有效的长期偏好");
    repository.updateMemoryValidity("mem-renew", { validUntil: "2026-08-01T00:00:00.000Z" }, "2026-07-01T00:00:00.000Z");
    retention.deprecateExpired(scope);
    assert.equal(memory.get("mem-renew", scope)?.governance.status, "deprecated");

    // 续期到未来：恢复 Verified 并回到召回
    const renewed = retention.renewMemory("mem-renew", scope, { validUntil: "2026-11-21T00:00:00.000Z" });
    assert.equal(renewed.governance.status, "verified");
    assert.equal(renewed.governance.validUntil, "2026-11-21T00:00:00.000Z");
    assert.equal(memory.recall({ query: "长期偏好", scope }).length, 1);

    // 续期为 null 表示清除期限（长期有效）
    repository.updateMemoryValidity("mem-renew", { validUntil: "2026-08-01T00:00:00.000Z" }, "2026-08-20T00:00:00.000Z");
    retention.deprecateExpired(scope);
    const permanent = retention.renewMemory("mem-renew", scope, { validUntil: null });
    assert.equal(permanent.governance.status, "verified");
    assert.equal(permanent.governance.validUntil, undefined);

    // 终态资产不能续期；未传 validUntil 视为无效请求
    memory.transition("mem-renew", scope, "archived");
    assert.throws(() => retention.renewMemory("mem-renew", scope, { validUntil: null }), /cannot renew archived/);
  } finally {
    repository.close();
  }
});

test("stale assets are surfaced for review without automatic action", () => {
  const now = () => new Date("2026-08-21T00:00:00.000Z");
  const { repository, memory, skills, retention } = setup(now);
  try {
    // 早已验证、长期未再验证的记忆（updatedAt 在 90 天阈值之前）
    const past = new MemoryService(repository, () => new Date("2026-01-01T00:00:00.000Z"));
    verifiedMemory(past, "mem-stale", "ev-stale", "很久没有重新验证的既定事实");
    memory.capture({ id: "ev-skill", scope, role: "user", content: "skill evidence" });
    const oldSkills = new SkillService(repository, () => new Date("2026-01-01T00:00:00.000Z"));
    const skill = oldSkills.create({
      id: "skill-stale", scope, name: "legacy-flow", description: "旧流程",
      content: "---\nname: legacy-flow\ndescription: 旧流程\n---\n\n# Workflow\n1. 旧步骤",
      sourceEvidenceIds: ["ev-skill"],
    });
    oldSkills.transition(skill.id, scope, "verified");

    const review = retention.review(scope);
    assert.ok(review.staleMemories.some((item) => item.id === "mem-stale"));
    assert.ok(review.staleSkills.some((item) => item.id === "skill-stale"));
    // 待复核只是提示：状态不变
    assert.equal(memory.get("mem-stale", scope)?.governance.status, "verified");
    // 阈值可通过参数收紧
    assert.deepEqual(retention.review(scope, { staleDays: 1 }).staleSkills.map((item) => item.id), ["skill-stale"]);
  } finally {
    repository.close();
  }
});
