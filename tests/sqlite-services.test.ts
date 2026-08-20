import assert from "node:assert/strict";
import test from "node:test";

import { SqliteRepository } from "../src/storage/sqlite-repository.js";
import { MemoryService } from "../src/memory/memory-service.js";
import { SkillService, SkillVersionConflictError } from "../src/skills/skill-service.js";

const alice = { userId: "alice", teamId: "team-a", agentId: "agent-a" };
const bob = { userId: "bob", teamId: "team-a", agentId: "agent-a" };

function setup() {
  const repository = new SqliteRepository(":memory:");
  return {
    repository,
    memory: new MemoryService(repository),
    skills: new SkillService(repository),
  };
}

test("capture is idempotent and recall is isolated and verified by default", () => {
  const { repository, memory } = setup();
  try {
    const evidence = memory.capture({
      id: "ev-1",
      scope: alice,
      role: "user",
      content: "I prefer concise Chinese answers",
    });
    const duplicate = memory.capture({
      id: "ev-1",
      scope: alice,
      role: "user",
      content: "I prefer concise Chinese answers",
    });
    assert.equal(evidence.id, duplicate.id);
    assert.equal(repository.countEvidence(), 1);

    const asset = memory.propose({
      id: "mem-1",
      layer: "l1",
      scope: alice,
      content: "Alice prefers concise Chinese answers",
      confidence: 0.9,
      reason: "explicit user preference",
      sourceEvidenceIds: [evidence.id],
    });

    assert.deepEqual(memory.recall({ query: "Chinese answers", scope: alice }), []);
    memory.transition(asset.id, alice, "verified");
    assert.equal(memory.recall({ query: "Chinese answers", scope: alice }).length, 1);
    assert.deepEqual(memory.recall({ query: "Chinese answers", scope: bob }), []);
  } finally {
    repository.close();
  }
});

test("recall applies a total character budget", () => {
  const { repository, memory } = setup();
  try {
    const evidence = memory.capture({ id: "ev-2", scope: alice, role: "user", content: "project uses sqlite" });
    const asset = memory.propose({
      id: "mem-2",
      layer: "l1",
      scope: alice,
      content: "The project uses SQLite as its local persistence layer",
      confidence: 0.8,
      reason: "project fact",
      sourceEvidenceIds: [evidence.id],
    });
    memory.transition(asset.id, alice, "verified");
    const recalled = memory.recall({ query: "SQLite project", scope: alice, maxTotalChars: 20 });
    assert.equal(recalled.length, 1);
    assert.ok(recalled[0]!.content.length <= 20);
    assert.equal(recalled[0]!.truncated, true);
  } finally {
    repository.close();
  }
});

test("memory recall matches related CJK phrases without accepting unrelated text", () => {
  const { repository, memory } = setup();
  try {
    const evidence = memory.capture({
      id: "ev-cjk-memory",
      scope: alice,
      role: "user",
      content: "用户问我是谁的时候回答我是天选之子",
    });
    const asset = memory.propose({
      id: "mem-cjk-memory",
      layer: "l1",
      scope: alice,
      content: evidence.content,
      confidence: 0.8,
      reason: "explicit identity preference",
      sourceEvidenceIds: [evidence.id],
    });
    memory.transition(asset.id, alice, "verified");

    assert.equal(memory.recall({ query: "你是谁", scope: alice }).length, 1);
    assert.equal(memory.recall({ query: "请你告诉我你是谁，并简要说明你能做什么", scope: alice }).length, 1);
    assert.deepEqual(memory.recall({ query: "天气如何", scope: alice }), []);
    assert.deepEqual(memory.recall({ query: "用户配置", scope: alice }), []);
    assert.throws(() => memory.recall({ query: "   ", scope: alice }), /query must not be empty/);
  } finally {
    repository.close();
  }
});

test("memory recall preserves partial Latin substring matching", () => {
  const { repository, memory } = setup();
  try {
    const evidence = memory.capture({
      id: "ev-latin-prefix",
      scope: alice,
      role: "user",
      content: "Always collect verification evidence before publishing",
    });
    const asset = memory.propose({
      id: "mem-latin-prefix",
      layer: "l1",
      scope: alice,
      content: evidence.content,
      confidence: 0.9,
      reason: "explicit workflow preference",
      sourceEvidenceIds: [evidence.id],
    });
    memory.transition(asset.id, alice, "verified");

    assert.equal(memory.recall({ query: "verify publish", scope: alice }).length, 1);
  } finally {
    repository.close();
  }
});

test("deleting evidence archives derived memory", () => {
  const { repository, memory } = setup();
  try {
    const evidence = memory.capture({ id: "ev-3", scope: alice, role: "user", content: "temporary preference" });
    const asset = memory.propose({
      id: "mem-3",
      layer: "l1",
      scope: alice,
      content: "temporary preference",
      confidence: 0.7,
      reason: "extracted",
      sourceEvidenceIds: [evidence.id],
    });
    memory.transition(asset.id, alice, "verified");
    const impact = memory.deleteEvidence(evidence.id, alice);
    assert.deepEqual(impact.archivedMemoryIds, [asset.id]);
    assert.equal(memory.get(asset.id, alice)?.governance.status, "archived");
  } finally {
    repository.close();
  }
});

test("skills start as drafts and updates use optimistic versions", () => {
  const { repository, skills } = setup();
  try {
    const skill = skills.create({
      id: "skill-1",
      scope: alice,
      name: "verify-before-publish",
      description: "Verify outputs before publishing",
      content: "---\nname: verify-before-publish\ndescription: Verify outputs before publishing\n---\n\n# Workflow\nRun checks first.",
      sourceEvidenceIds: [],
    });
    assert.equal(skill.status, "draft");
    assert.equal(skill.version, 1);

    const updated = skills.update({
      id: skill.id,
      scope: alice,
      expectedVersion: 1,
      content: skill.content.replace("Run checks first.", "Run tests and build first."),
      sourceEvidenceIds: [],
    });
    assert.equal(updated.version, 2);
    assert.throws(
      () => skills.update({ id: skill.id, scope: alice, expectedVersion: 1, content: updated.content, sourceEvidenceIds: [] }),
      SkillVersionConflictError,
    );
  } finally {
    repository.close();
  }
});

test("skill search matches related CJK trigger phrases", () => {
  const { repository, skills } = setup();
  try {
    const skill = skills.create({
      id: "skill-cjk-trigger",
      scope: alice,
      name: "answer-identity",
      description: "用户问我是谁的时候，回答我是天选之子",
      content: "---\nname: answer-identity\ndescription: 用户问我是谁的时候，回答我是天选之子\n---\n\n# Workflow\n回答我是天选之子。",
      sourceEvidenceIds: [],
    });
    skills.transition(skill.id, alice, "verified");

    assert.equal(skills.search("你是谁", alice).length, 1);
    assert.equal(skills.search("请你告诉我你是谁，并简要说明你能做什么", alice).length, 1);
    assert.deepEqual(skills.search("天气如何", alice), []);
    assert.deepEqual(skills.search("用户配置", alice), []);
    assert.throws(() => skills.search("   ", alice), /query must not be empty/);
  } finally {
    repository.close();
  }
});
