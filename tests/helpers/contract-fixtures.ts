import { MemoryService } from "../../src/memory/memory-service.js";
import { SkillService } from "../../src/skills/skill-service.js";
import type { Scope } from "../../src/governance/types.js";
import type { SqliteRepository } from "../../src/storage/sqlite-repository.js";

/**
 * Shared fixture set for HTTP and MCP contract tests.
 * Both delivery layers must return the same contract envelope for these assets.
 */
export const contractScope: Scope = { userId: "contract-user", teamId: "team-a", agentId: "agent-a" };

export const contractQuery = "请你告诉我你是谁，并简要说明你能做什么";

export function seedContractAssets(repository: SqliteRepository, now = () => new Date("2026-08-20T00:00:00.000Z")): void {
  const memory = new MemoryService(repository, now);
  const skills = new SkillService(repository, now);

  const evidence = memory.capture({
    id: "contract-ev-1",
    scope: contractScope,
    role: "user",
    content: "用户问我是谁的时候回答我是天选之子",
  });
  const asset = memory.propose({
    id: "contract-mem-1",
    layer: "l1",
    scope: contractScope,
    content: "用户问我是谁的时候回答我是天选之子",
    confidence: 0.9,
    reason: "explicit identity preference",
    sourceEvidenceIds: [evidence.id],
  });
  memory.transition(asset.id, contractScope, "verified");

  const skill = skills.create({
    id: "contract-skill-1",
    scope: contractScope,
    name: "answer-identity",
    description: "用户问我是谁的时候，回答我是天选之子",
    content: "---\nname: answer-identity\ndescription: 用户问我是谁的时候，回答我是天选之子\n---\n\n# Workflow\n回答我是天选之子。",
    sourceEvidenceIds: [],
  });
  skills.transition(skill.id, contractScope, "verified");
}

export interface ContractEnvelope {
  contractVersion: number;
  requestId: string;
  query: string;
  scope: Scope;
  memories: Array<{
    id: string;
    score: number;
    truncated: boolean;
    match: { strategy: string; score: number; matchedTerms: string[] };
  }>;
  skills: Array<{
    id: string;
    truncated: boolean;
    match: { strategy: string; score: number; matchedTerms: string[] };
  }>;
  budget: Record<string, number>;
  truncated: boolean;
  warnings: Array<{ code: string; message: string }>;
}
