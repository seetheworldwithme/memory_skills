import type { Scope } from "../governance/types.js";
import type { RecalledMemory } from "../memory/types.js";
import type { RecalledSkill } from "./types.js";

/**
 * HTTP API 与 MCP 适配器共享的版本化上下文召回契约。
 *
 * 兼容性规则：
 * - 新增可选字段或新告警码，版本号不变；
 * - 删除字段、改名字段或改变语义，必须提升 CONTRACT_VERSION。
 */
export const CONTRACT_VERSION = 1;

/**
 * 命中策略：lexical 为纯词法；vector 为纯语义向量命中（词法零命中）；
 * hybrid 为两通道同时命中后的融合分。向后兼容地扩展自 "lexical"，
 * 消费方按字符串处理即可。
 */
export type MatchStrategy = "lexical" | "vector" | "hybrid";

export interface MatchMetadata {
  /** 产生该结果的检索策略；不暴露存储细节。 */
  strategy: MatchStrategy;
  /** 归一化相关性分数，范围 (0, 1]。 */
  score: number;
  /** 查询中实际命中该资产的片段。 */
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
  | "SKILL_RESULTS_DROPPED"
  | "RETRIEVAL_DEGRADED_LEXICAL";

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
