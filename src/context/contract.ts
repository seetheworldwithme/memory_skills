import type { Scope } from "../governance/types.js";
import type { RecalledMemory } from "../memory/types.js";
import type { RecalledSkill } from "./types.js";

/**
 * Versioned context recall contract shared by the HTTP API and the MCP adapter.
 *
 * Compatibility rules:
 * - Adding optional fields or new warning codes keeps the version unchanged.
 * - Removing fields, renaming fields, or changing semantics bumps CONTRACT_VERSION.
 */
export const CONTRACT_VERSION = 1;

export type MatchStrategy = "lexical";

export interface MatchMetadata {
  /** Which retrieval strategy produced this item; never exposes storage detail. */
  strategy: MatchStrategy;
  /** Normalized relevance score in (0, 1]. */
  score: number;
  /** Query fragments that matched this item. */
  matchedTerms: string[];
}

export interface ContractedMemory extends RecalledMemory {
  match: MatchMetadata;
}

export interface ContractedSkill extends RecalledSkill {
  match: MatchMetadata;
}

export type WarningCode =
  | "MEMORY_BUDGET_TRUNCATED"
  | "SKILL_BUDGET_TRUNCATED"
  | "MEMORY_RESULTS_DROPPED"
  | "SKILL_RESULTS_DROPPED";

export interface ContractWarning {
  code: WarningCode;
  message: string;
}

export interface ContextBudgetReport {
  maxMemoryResults: number;
  maxMemoryChars: number;
  maxSkillResults: number;
  maxSkillChars: number;
  usedMemoryChars: number;
  usedSkillChars: number;
}

export interface ContextRecallResponse {
  contractVersion: number;
  requestId: string;
  query: string;
  scope: Scope;
  memories: ContractedMemory[];
  skills: ContractedSkill[];
  budget: ContextBudgetReport;
  truncated: boolean;
  warnings: ContractWarning[];
}

export function isContextRecallResponse(value: unknown): value is ContextRecallResponse {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<ContextRecallResponse>;
  return candidate.contractVersion === CONTRACT_VERSION
    && typeof candidate.requestId === "string" && candidate.requestId.length > 0
    && typeof candidate.query === "string"
    && isScope(candidate.scope)
    && Array.isArray(candidate.memories)
    && Array.isArray(candidate.skills)
    && isBudget(candidate.budget)
    && typeof candidate.truncated === "boolean"
    && Array.isArray(candidate.warnings);
}

function isScope(value: unknown): value is Scope {
  if (typeof value !== "object" || value === null) return false;
  const scope = value as Partial<Scope>;
  return typeof scope.userId === "string"
    && typeof scope.teamId === "string"
    && typeof scope.agentId === "string"
    && (scope.sessionId === undefined || typeof scope.sessionId === "string");
}

function isBudget(value: unknown): value is ContextBudgetReport {
  if (typeof value !== "object" || value === null) return false;
  const budget = value as Partial<ContextBudgetReport>;
  return [budget.maxMemoryResults, budget.maxMemoryChars, budget.maxSkillResults, budget.maxSkillChars,
    budget.usedMemoryChars, budget.usedSkillChars]
    .every((field) => typeof field === "number" && Number.isFinite(field));
}
