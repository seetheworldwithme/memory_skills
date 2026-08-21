import assert from "node:assert/strict";
import test from "node:test";

import { SqliteRepository } from "../src/storage/sqlite-repository.js";
import { MemoryService } from "../src/memory/memory-service.js";
import { SkillService } from "../src/skills/skill-service.js";

const scope = { userId: "alice", teamId: "team-a", agentId: "agent-a" };

function setup(now: () => Date = () => new Date("2026-08-21T00:00:00.000Z")) {
  const repository = new SqliteRepository(":memory:");
  return {
    repository,
    memory: new MemoryService(repository, now),
    skills: new SkillService(repository, now),
  };
}

function skillContent(description: string, workflow: string, extra = ""): string {
  return `---\nname: deploy-service\ndescription: ${description}\n---\n\n# deploy-service\n\n## When to use\n\n需要部署服务时。\n\n## Workflow\n\n${workflow}${extra}`;
}

function seedVerifiedSkill(skills: SkillService, memory: MemoryService): string {
  memory.capture({ id: "ev-1", scope, role: "user", content: "deploy steps" });
  const skill = skills.create({
    id: "skill-1",
    scope,
    name: "deploy-service",
    description: "按清单部署服务",
    content: skillContent("按清单部署服务", "1. 构建镜像\n2. 滚动更新"),
    sourceEvidenceIds: ["ev-1"],
  });
  skills.transition(skill.id, scope, "verified");
  return skill.id;
}

test("version history keeps every generation with a status snapshot", () => {
  const { repository, memory, skills } = setup();
  try {
    const id = seedVerifiedSkill(skills, memory);
    // 编辑已发布 Skill：产生 v2 Draft（描述与工作流都有变化），v1 保留 verified 快照
    skills.update({
      id,
      scope,
      expectedVersion: 1,
      description: "按清单部署服务（含健康检查）",
      content: skillContent("按清单部署服务（含健康检查）", "1. 构建镜像\n2. 滚动更新\n3. 健康检查"),
      sourceEvidenceIds: ["ev-1"],
    });
    const versions = skills.listVersions(id, scope);
    assert.deepEqual(versions.map((version) => [version.version, version.status]), [[2, "draft"], [1, "verified"]]);
    assert.equal(versions[1]!.content.includes("构建镜像"), true);

    // Verify v2：当前版本快照随之更新，历史版本不受影响
    skills.transition(id, scope, "verified");
    assert.deepEqual(
      skills.listVersions(id, scope).map((version) => [version.version, version.status]),
      [[2, "verified"], [1, "verified"]],
    );
  } finally {
    repository.close();
  }
});

test("diff against the latest published version summarizes semantic changes", () => {
  const { repository, memory, skills } = setup();
  try {
    const id = seedVerifiedSkill(skills, memory);
    skills.update({
      id,
      scope,
      expectedVersion: 1,
      description: "按清单部署服务（含健康检查）",
      content: skillContent("按清单部署服务（含健康检查）", "1. 构建镜像\n2. 滚动更新\n3. 健康检查", "\n\n## Failure handling\n\n失败时回滚上一个版本。\n"),
      sourceEvidenceIds: ["ev-1"],
    });

    // 默认对照最近已发布版本（v1）与当前 Draft（v2）
    const diff = skills.diff(id, scope);
    assert.equal(diff.fromVersion, 1);
    assert.equal(diff.toVersion, 2);
    const fieldChange = diff.entries.find((entry) => entry.kind === "field" && entry.target === "description");
    assert.equal(fieldChange?.change, "modified");
    assert.equal(fieldChange?.before, "按清单部署服务");
    assert.equal(fieldChange?.after, "按清单部署服务（含健康检查）");
    const workflowChange = diff.entries.find((entry) => entry.kind === "section" && entry.target === "Workflow");
    assert.equal(workflowChange?.change, "modified");
    assert.deepEqual(workflowChange?.addedLines, ["3. 健康检查"]);
    const addedSection = diff.entries.find((entry) => entry.kind === "section" && entry.target === "Failure handling");
    assert.equal(addedSection?.change, "added");
    assert.ok(diff.summary.includes("字段「description」修改"));

    // 显式指定版本对照
    const explicit = skills.diff(id, scope, { fromVersion: 1, toVersion: 1 });
    assert.equal(explicit.summary, "与对照版本内容一致");

    // 首个版本没有可比历史
    const first = skills.diff(id, scope, { toVersion: 1 });
    assert.equal(first.fromVersion, null);
    assert.equal(first.summary, "首个版本，没有可比较的历史版本");
  } finally {
    repository.close();
  }
});

test("rollback appends a new draft version instead of overwriting history", () => {
  const { repository, memory, skills } = setup();
  try {
    const id = seedVerifiedSkill(skills, memory);
    const v1Content = skills.get(id, scope)!.content;
    const updated = skills.update({
      id,
      scope,
      expectedVersion: 1,
      description: "完全不同的描述",
      content: skillContent("完全不同的描述", "1. 全新流程"),
      sourceEvidenceIds: ["ev-1"],
    });
    assert.equal(updated.version, 2);

    // 回滚到 v1：产生 v3 Draft，内容等于 v1，v2 原样保留
    const rolledBack = skills.rollback(id, scope, 1);
    assert.equal(rolledBack.version, 3);
    assert.equal(rolledBack.status, "draft");
    assert.equal(rolledBack.content, v1Content);
    const versions = skills.listVersions(id, scope);
    assert.equal(versions.length, 3);
    assert.ok(versions.some((version) => version.version === 2 && version.content.includes("全新流程")));

    // 回滚到当前版本没有意义，应拒绝
    assert.throws(() => skills.rollback(id, scope, 3), /cannot rollback to current version/);
    assert.throws(() => skills.rollback(id, scope, 99), /skill version not found/);

    // 回滚后仍需人工 Verify 才回到已发布状态
    const verified = skills.transition(id, scope, "verified");
    assert.equal(verified.version, 3);
    assert.equal(verified.status, "verified");
  } finally {
    repository.close();
  }
});

test("rollback keeps only sources whose evidence still exists", () => {
  const { repository, memory, skills } = setup();
  try {
    memory.capture({ id: "ev-1", scope, role: "user", content: "deploy steps" });
    memory.capture({ id: "ev-2", scope, role: "user", content: "extra context" });
    const skill = skills.create({
      id: "skill-2",
      scope,
      name: "deploy-service",
      description: "按清单部署服务",
      content: skillContent("按清单部署服务", "1. 构建镜像"),
      sourceEvidenceIds: ["ev-1", "ev-2"],
    });
    skills.transition(skill.id, scope, "verified");
    skills.update({
      id: skill.id,
      scope,
      expectedVersion: 1,
      description: "改过的描述",
      content: skillContent("改过的描述", "1. 新流程"),
      sourceEvidenceIds: ["ev-1", "ev-2"],
    });
    // 删除 ev-2：链接行被级联清除，剩余来源仍可支撑回滚
    memory.deleteEvidence("ev-2", scope);
    const rolledBack = skills.rollback(skill.id, scope, 1);
    assert.deepEqual(rolledBack.sources.map((source) => source.evidenceId), ["ev-1"]);
  } finally {
    repository.close();
  }
});

test("run records produce an evidence-based effectiveness summary", () => {
  const { repository, memory, skills } = setup();
  try {
    const id = seedVerifiedSkill(skills, memory);

    // 没有任何使用记录：不宣称有效
    const empty = skills.runSummary(id, scope);
    assert.equal(empty.verdict, "no-evidence");
    assert.equal(empty.hasEvidence, false);

    skills.recordRun({ skillId: id, scope, event: "recalled", requestId: "req-1" });
    skills.recordRun({ skillId: id, scope, event: "adopted", requestId: "req-1" });
    skills.recordRun({ skillId: id, scope, event: "succeeded", requestId: "req-1", note: "部署成功" });

    const summary = skills.runSummary(id, scope);
    assert.deepEqual(summary.runs, { recalled: 1, adopted: 1, succeeded: 1, failed: 0 });
    assert.equal(summary.verdict, "supported");
    assert.equal(summary.hasEvidence, true);

    // 失败记录占优时结论转为建议复核
    skills.recordRun({ skillId: id, scope, event: "failed" });
    skills.recordRun({ skillId: id, scope, event: "failed" });
    assert.equal(skills.runSummary(id, scope).verdict, "contradicted");

    // 使用事件四选一，未知事件拒绝
    assert.throws(() => skills.recordRun({ skillId: id, scope, event: "magic" as never }));
    // 资产必须存在且属于该作用域
    assert.throws(() => skills.recordRun({ skillId: "missing", scope, event: "recalled" }), /skill not found/);
  } finally {
    repository.close();
  }
});

test("skill creation rejects sensitive content before it enters the database", () => {
  const { repository, skills } = setup();
  try {
    assert.throws(() => skills.create({
      id: "skill-secret",
      scope,
      name: "deploy-service",
      description: "内含密钥",
      content: "---\nname: deploy-service\ndescription: 内含密钥\n---\n\napi_key=sk-abcdefgh1234567890",
      sourceEvidenceIds: [],
    }), /sensitive/);
  } finally {
    repository.close();
  }
});
