import { randomUUID } from "node:crypto";

import type { MemoryService } from "../memory/memory-service.js";
import type { SkillService } from "../skills/skill-service.js";
import { lexicalScore, matchedQueryTerms } from "../retrieval/text-match.js";
import type { ContextRecallInput } from "./types.js";
import {
  CONTRACT_VERSION,
  type ContractWarning,
  type ContractedMemory,
  type ContractedSkill,
  type ContextBudgetReport,
  type ContextRecallResponse,
  type MatchMetadata,
} from "./contract.js";

export class ContextService {
  constructor(
    private readonly memory: MemoryService,
    private readonly skills: SkillService,
    private readonly newRequestId: () => string = randomUUID,
  ) {}

  recall(input: ContextRecallInput): ContextRecallResponse {
    const maxMemoryResults = positiveInteger(input.maxMemoryResults ?? 5, "maxMemoryResults");
    const maxMemoryChars = positiveInteger(input.maxMemoryChars ?? 4_000, "maxMemoryChars");
    const maxSkillResults = positiveInteger(input.maxSkillResults ?? 3, "maxSkillResults");
    const maxSkillChars = positiveInteger(input.maxSkillChars ?? 8_000, "maxSkillChars");

    const rankedMemories = this.memory.recallRanked({
      query: input.query,
      scope: input.scope,
      ...(input.includeDraft === undefined ? {} : { includeDraft: input.includeDraft }),
      maxResults: maxMemoryResults * RESULT_HEADROOM,
      maxTotalChars: Number.MAX_SAFE_INTEGER,
    });
    const warnings: ContractWarning[] = [];
    const droppedMemories = rankedMemories.length - Math.min(rankedMemories.length, maxMemoryResults);
    const topMemories = rankedMemories.slice(0, maxMemoryResults);

    let usedMemoryChars = 0;
    let memoryTruncated = false;
    const memories: ContractedMemory[] = [];
    for (const memory of topMemories) {
      if (usedMemoryChars >= maxMemoryChars) break;
      const room = maxMemoryChars - usedMemoryChars;
      const content = memory.content.length > room ? memory.content.slice(0, room) : memory.content;
      const truncated = content.length < memory.content.length;
      memoryTruncated ||= truncated;
      usedMemoryChars += content.length;
      memories.push({ ...memory, content, truncated, match: lexicalMatch(input.query, memory.content, memory.score) });
    }

    const matchedSkills = this.skills.searchRanked(input.query, input.scope, input.includeDraft);
    const droppedSkills = matchedSkills.length - Math.min(matchedSkills.length, maxSkillResults);
    const topSkills = matchedSkills.slice(0, maxSkillResults);

    let usedSkillChars = 0;
    let skillTruncated = false;
    const skills: ContractedSkill[] = [];
    for (const skill of topSkills) {
      if (usedSkillChars >= maxSkillChars) break;
      const room = maxSkillChars - usedSkillChars;
      const content = skill.content.length > room ? skill.content.slice(0, room) : skill.content;
      const truncated = content.length < skill.content.length;
      skillTruncated ||= truncated;
      usedSkillChars += content.length;
      skills.push({ ...skill, content, truncated, match: lexicalMatch(input.query, skillSearchText(skill), lexicalScore(input.query, skillSearchText(skill))) });
    }

    if (memoryTruncated) {
      warnings.push({ code: "MEMORY_BUDGET_TRUNCATED", message: "memory results were truncated to fit maxMemoryChars" });
    }
    if (skillTruncated) {
      warnings.push({ code: "SKILL_BUDGET_TRUNCATED", message: "skill results were truncated to fit maxSkillChars" });
    }
    if (droppedMemories > 0) {
      warnings.push({ code: "MEMORY_RESULTS_DROPPED", message: `${droppedMemories} matching memories exceeded maxMemoryResults` });
    }
    if (droppedSkills > 0) {
      warnings.push({ code: "SKILL_RESULTS_DROPPED", message: `${droppedSkills} matching skills exceeded maxSkillResults` });
    }

    const budget: ContextBudgetReport = {
      maxMemoryResults,
      maxMemoryChars,
      maxSkillResults,
      maxSkillChars,
      usedMemoryChars,
      usedSkillChars,
    };

    return {
      contractVersion: CONTRACT_VERSION,
      requestId: this.newRequestId(),
      query: input.query,
      scope: input.scope,
      memories,
      skills,
      budget,
      truncated: memoryTruncated || skillTruncated,
      warnings,
    };
  }
}

/**
 * MemoryService.recallRanked slices by maxResults before the char budget is applied here,
 * so request extra headroom to distinguish "dropped by count" from "dropped by chars".
 */
const RESULT_HEADROOM = 2;

function lexicalMatch(query: string, content: string, score: number): MatchMetadata {
  return {
    strategy: "lexical",
    score: Number(score.toFixed(4)),
    matchedTerms: matchedQueryTerms(query, content),
  };
}

function skillSearchText(skill: { name: string; description: string; content: string }): string {
  return `${skill.name} ${skill.description} ${skill.content}`;
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${field} must be a positive integer`);
  return value;
}
