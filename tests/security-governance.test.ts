import assert from "node:assert/strict";
import test from "node:test";

import { MemoryService } from "../src/memory/memory-service.js";
import { SkillService } from "../src/skills/skill-service.js";
import { SqliteRepository } from "../src/storage/sqlite-repository.js";

const alice = { userId: "alice", teamId: "team", agentId: "agent", sessionId: "s1" };
const bob = { userId: "bob", teamId: "team", agentId: "agent", sessionId: "s1" };

test("evidence ID collision cannot expose or overwrite another scope", () => {
  const repository = new SqliteRepository(":memory:");
  const memory = new MemoryService(repository);
  try {
    memory.capture({ id: "same-id", scope: alice, role: "user", content: "alice secret" });
    assert.throws(
      () => memory.capture({ id: "same-id", scope: bob, role: "user", content: "bob text" }),
      /evidence id conflict/,
    );
  } finally {
    repository.close();
  }
});

test("memory cannot derive from evidence in another scope", () => {
  const repository = new SqliteRepository(":memory:");
  const memory = new MemoryService(repository);
  try {
    memory.capture({ id: "alice-ev", scope: alice, role: "user", content: "alice only" });
    assert.throws(() => memory.propose({
      id: "bob-mem",
      layer: "l1",
      scope: bob,
      content: "stolen",
      confidence: 0.9,
      reason: "invalid",
      sourceEvidenceIds: ["alice-ev"],
    }), /source evidence scope mismatch/);
  } finally {
    repository.close();
  }
});

test("memory mutations require the owning scope", () => {
  const repository = new SqliteRepository(":memory:");
  const memory = new MemoryService(repository);
  try {
    memory.capture({ id: "ev", scope: alice, role: "user", content: "fact" });
    memory.propose({ id: "mem", layer: "l1", scope: alice, content: "fact", confidence: 1, reason: "fact", sourceEvidenceIds: ["ev"] });
    assert.throws(() => memory.transition("mem", bob, "verified"), /memory not found/);
    assert.equal(memory.transition("mem", alice, "verified").governance.status, "verified");
  } finally {
    repository.close();
  }
});

test("editing a verified skill creates a draft version and evidence deletion archives it", () => {
  const repository = new SqliteRepository(":memory:");
  const memory = new MemoryService(repository);
  const skills = new SkillService(repository);
  try {
    memory.capture({ id: "skill-ev", scope: alice, role: "user", content: "verify first" });
    const skill = skills.create({
      id: "skill",
      scope: alice,
      name: "verify-first",
      description: "Verify first",
      content: "---\nname: verify-first\ndescription: Verify first\n---\n\n# Workflow\nVerify.",
      sourceEvidenceIds: ["skill-ev"],
    });
    skills.transition(skill.id, alice, "verified");
    const updated = skills.update({
      id: skill.id,
      scope: alice,
      expectedVersion: 1,
      content: skill.content.replace("Verify.", "Run tests."),
      sourceEvidenceIds: ["skill-ev"],
    });
    assert.equal(updated.status, "draft");
    const impact = memory.deleteEvidence("skill-ev", alice);
    assert.deepEqual(impact.archivedSkillIds, [skill.id]);
    assert.equal(skills.get(skill.id, alice)?.status, "archived");
  } finally {
    repository.close();
  }
});

test("recall rejects invalid budgets and respects validFrom", () => {
  const repository = new SqliteRepository(":memory:");
  const memory = new MemoryService(repository, () => new Date("2026-01-01T00:00:00.000Z"));
  try {
    memory.capture({ id: "future-ev", scope: alice, role: "user", content: "future fact" });
    const asset = memory.propose({
      id: "future-mem",
      layer: "l1",
      scope: alice,
      content: "future fact",
      confidence: 1,
      reason: "scheduled",
      sourceEvidenceIds: ["future-ev"],
      validFrom: "2027-01-01T00:00:00.000Z",
    });
    memory.transition(asset.id, alice, "verified");
    assert.deepEqual(memory.recall({ query: "future", scope: alice }), []);
    assert.throws(() => memory.recall({ query: "future", scope: alice, maxResults: -1 }), /maxResults/);
  } finally {
    repository.close();
  }
});

test("skill frontmatter must be structurally valid and metadata-consistent", () => {
  const repository = new SqliteRepository(":memory:");
  const skills = new SkillService(repository);
  try {
    assert.throws(() => skills.create({
      id: "bad-skill",
      scope: alice,
      name: "bad-skill",
      description: "Expected description",
      content: "---\nname: bad-skill\ndescription:\n---\n\n# Empty",
      sourceEvidenceIds: [],
    }), /description/);
    assert.throws(() => skills.create({
      id: "mismatch-skill",
      scope: alice,
      name: "mismatch-skill",
      description: "Expected description",
      content: "---\nname: mismatch-skill\ndescription: Different description\n---\n\n# Mismatch",
      sourceEvidenceIds: [],
    }), /must match/);
  } finally {
    repository.close();
  }
});

test("skills enforce exact evidence and session scope", () => {
  const repository = new SqliteRepository(":memory:");
  const memory = new MemoryService(repository);
  const skills = new SkillService(repository);
  try {
    memory.capture({ id: "alice-session-evidence", scope: alice, role: "user", content: "private" });
    assert.throws(() => skills.create({
      id: "foreign-skill",
      scope: bob,
      name: "foreign-skill",
      description: "Must fail",
      content: "---\nname: foreign-skill\ndescription: Must fail\n---\n\n# Fail",
      sourceEvidenceIds: ["alice-session-evidence"],
    }), /source evidence not found in scope/);

    const skill = skills.create({
      id: "session-skill",
      scope: alice,
      name: "session-skill",
      description: "Session scoped",
      content: "---\nname: session-skill\ndescription: Session scoped\n---\n\n# Session",
      sourceEvidenceIds: ["alice-session-evidence"],
    });
    const otherSession = { ...alice, sessionId: "s2" };
    assert.equal(skills.get(skill.id, otherSession), undefined);
    assert.deepEqual(skills.list(otherSession), []);
  } finally {
    repository.close();
  }
});

test("sessionless memory scope does not aggregate session assets", () => {
  const repository = new SqliteRepository(":memory:");
  const memory = new MemoryService(repository);
  try {
    memory.capture({ id: "session-only-ev", scope: alice, role: "user", content: "session only" });
    const asset = memory.propose({ id: "session-only-mem", layer: "l1", scope: alice, content: "session only", confidence: 1, reason: "test", sourceEvidenceIds: ["session-only-ev"] });
    memory.transition(asset.id, alice, "verified");
    const noSession = { userId: alice.userId, teamId: alice.teamId, agentId: alice.agentId };
    assert.deepEqual(memory.list(noSession), []);
  } finally {
    repository.close();
  }
});

test("archived skills cannot be updated back into draft", () => {
  const repository = new SqliteRepository(":memory:");
  const skills = new SkillService(repository);
  try {
    const skill = skills.create({
      id: "terminal-skill",
      scope: alice,
      name: "terminal-skill",
      description: "Terminal",
      content: "---\nname: terminal-skill\ndescription: Terminal\n---\n\n# Terminal",
      sourceEvidenceIds: [],
    });
    skills.transition(skill.id, alice, "archived");
    assert.throws(() => skills.update({
      id: skill.id,
      scope: alice,
      expectedVersion: 1,
      content: skill.content,
      sourceEvidenceIds: [],
    }), /cannot update archived skill/);
  } finally {
    repository.close();
  }
});
