import type { GovernanceMetadata, Scope, SourceReference } from "../governance/types.js";
import type { MatchMetadata } from "../context/contract.js";

export type MemoryLayer = "l1" | "l2" | "l3";
export type EvidenceRole = "user" | "assistant" | "system" | "tool";

export interface Evidence {
  id: string;
  scope: Scope;
  role: EvidenceRole;
  content: string;
  capturedAt: string;
  /**
   * 证据的来源会话（可选，迁移 005 新增）：与 scope.sessionId（作用域过滤键）
   * 解耦——记录"这句话发生在哪个宿主会话"，供"多独立会话佐证"等规则使用，
   * 不参与作用域可见性过滤。
   */
  originSessionId?: string;
}

export interface MemoryAsset {
  id: string;
  layer: MemoryLayer;
  scope: Scope;
  content: string;
  governance: GovernanceMetadata;
  sources: SourceReference[];
}

export interface RecalledMemory extends MemoryAsset {
  score: number;
  truncated: boolean;
  /**
   * 命中解释（策略/分数/命中片段）：MCP 工具目录的输出 Schema 对每条命中
   * 都要求该字段（含 recall_memory 与 recall_context 的 memories 数组），
   * HTTP /v1/recall 与上下文契约使用同一结构，宿主据此解释"为什么被召回"。
   */
  match: MatchMetadata;
}

