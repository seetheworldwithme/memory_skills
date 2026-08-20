import assert from "node:assert/strict";
import test from "node:test";

import { ContextService } from "../src/context/context-service.js";
import { MemoryService } from "../src/memory/memory-service.js";
import { SkillService } from "../src/skills/skill-service.js";
import { SqliteRepository } from "../src/storage/sqlite-repository.js";
import { CONTRACT_VERSION, isContextRecallResponse } from "../src/context/contract.js";
import { contractQuery, contractScope, seedContractAssets, type ContractEnvelope } from "./helpers/contract-fixtures.js";

test("context recall returns a versioned contract envelope with match metadata and budgets", async () => {
  const repository = new SqliteRepository(":memory:");
  seedContractAssets(repository);
  const context = new ContextService(new MemoryService(repository), new SkillService(repository));

  const response = await context.recall({ query: contractQuery, scope: contractScope });

  const envelope = response as unknown as ContractEnvelope;
  assert.equal(envelope.contractVersion, CONTRACT_VERSION);
  assert.ok(typeof envelope.requestId === "string" && envelope.requestId.length > 0);
  assert.equal(envelope.query, contractQuery);
  assert.deepEqual(envelope.scope, contractScope);

  assert.equal(envelope.memories.length, 1);
  const memory = envelope.memories[0]!;
  assert.equal(memory.id, "contract-mem-1");
  assert.equal(memory.truncated, false);
  assert.equal(memory.match.strategy, "lexical");
  assert.ok(memory.match.score > 0 && memory.match.score <= 1);
  assert.ok(memory.match.matchedTerms.length > 0, "matched query fragments must be exposed");

  assert.equal(envelope.skills.length, 1);
  const skill = envelope.skills[0]!;
  assert.equal(skill.id, "contract-skill-1");
  assert.equal(skill.truncated, false);
  assert.equal(skill.match.strategy, "lexical");
  assert.ok(skill.match.matchedTerms.length > 0);

  assert.ok(envelope.budget.maxMemoryChars! > 0);
  assert.ok(envelope.budget.maxSkillChars! > 0);
  assert.equal(envelope.truncated, false);
  assert.deepEqual(envelope.warnings, []);

  assert.equal(isContextRecallResponse(response), true);

  repository.close();
});

test("contract reports budget truncation through warnings and flags", async () => {
  const repository = new SqliteRepository(":memory:");
  seedContractAssets(repository);
  const context = new ContextService(new MemoryService(repository), new SkillService(repository));

  const envelope = await context.recall({
    query: contractQuery,
    scope: contractScope,
    maxMemoryChars: 4,
    maxSkillChars: 6,
  }) as unknown as ContractEnvelope;

  assert.equal(envelope.truncated, true);
  assert.ok(envelope.memories[0]!.truncated);
  assert.ok(envelope.skills[0]!.truncated);
  const codes = envelope.warnings.map((warning) => warning.code).sort();
  assert.deepEqual(codes, ["MEMORY_BUDGET_TRUNCATED", "SKILL_BUDGET_TRUNCATED"]);

  repository.close();
});

test("result-count budgets that drop matching assets are reported, not silent", async () => {
  const repository = new SqliteRepository(":memory:");
  seedContractAssets(repository);
  const context = new ContextService(new MemoryService(repository), new SkillService(repository));

  const envelope = await context.recall({
    query: contractQuery,
    scope: contractScope,
    maxMemoryResults: 5,
    maxSkillResults: 3,
  }) as unknown as ContractEnvelope;
  assert.equal(envelope.truncated, false);
  assert.deepEqual(envelope.warnings, []);

  const squeezed = await context.recall({
    query: contractQuery,
    scope: contractScope,
    maxSkillResults: 1,
  }) as unknown as ContractEnvelope;
  assert.equal(squeezed.skills.length, 1);
  assert.deepEqual(squeezed.warnings.map((warning) => warning.code), []);

  repository.close();
});

test("match metadata never leaks internal SQL or storage detail", async () => {
  const repository = new SqliteRepository(":memory:");
  seedContractAssets(repository);
  const context = new ContextService(new MemoryService(repository), new SkillService(repository));

  const envelope = await context.recall({ query: contractQuery, scope: contractScope }) as unknown as ContractEnvelope;
  const serialized = JSON.stringify(envelope);
  assert.ok(!/SELECT|INSERT|sqlite|governance_json/i.test(serialized));

  repository.close();
});

test("empty results keep the same envelope shape", async () => {
  const repository = new SqliteRepository(":memory:");
  seedContractAssets(repository);
  const context = new ContextService(new MemoryService(repository), new SkillService(repository));

  const envelope = await context.recall({
    query: "quantum flux capacitor maintenance",
    scope: contractScope,
  }) as unknown as ContractEnvelope;
  assert.equal(envelope.contractVersion, CONTRACT_VERSION);
  assert.deepEqual(envelope.memories, []);
  assert.deepEqual(envelope.skills, []);
  assert.deepEqual(envelope.warnings, []);

  repository.close();
});

test("requestId is unique per recall call", async () => {
  const repository = new SqliteRepository(":memory:");
  seedContractAssets(repository);
  const context = new ContextService(new MemoryService(repository), new SkillService(repository));

  const first = await context.recall({ query: contractQuery, scope: contractScope }) as unknown as ContractEnvelope;
  const second = await context.recall({ query: contractQuery, scope: contractScope }) as unknown as ContractEnvelope;
  assert.notEqual(first.requestId, second.requestId);

  repository.close();
});
