import type { Scope } from "../governance/types.js";
import type { Evidence, MemoryLayer } from "../memory/types.js";
import type { LlmUsage } from "../llm/types.js";

export interface MemoryProposal {
  layer: MemoryLayer;
  content: string;
  confidence: number;
  reason: string;
  sourceEvidenceIds: string[];
}

export interface SkillProposal {
  name: string;
  description: string;
  content: string;
  sourceEvidenceIds: string[];
}

export interface MemoryProposalExtractor {
  propose(input: { scope: Scope; evidence: Evidence[] }): Promise<MemoryProposal[]>;
}

export interface SkillProposalExtractor {
  propose(input: { scope: Scope; evidence: Evidence[] }): Promise<SkillProposal[]>;
}

/**
 * Extractors only produce drafts. Publishing is intentionally owned by the
 * governance/application layer, never by an LLM tool call.
 */
export interface ProposalReviewPolicy {
  canAutoVerify(input: {
    kind: "memory" | "skill";
    scope: Scope;
    confidence?: number;
    sensitivity: "normal" | "sensitive" | "restricted";
  }): boolean;
}

/** 提案 Job 输入：人工触发时指定证据范围（本阶段不自动运行）。 */
export interface ProposalJobInput {
  scope: Scope;
  /** 显式指定证据 ID；缺省时取该作用域最近的证据。 */
  evidenceIds?: string[];
  /** 缺省取最近证据时的条数上限，默认 20。 */
  maxEvidence?: number;
}

/** 被拒绝的候选及其原因，进入提案报告供人工复核。 */
export interface RejectedCandidate {
  /** 候选在模型输出中的序号（从 1 开始）。 */
  index: number;
  /** 候选内容摘要（截断），便于审核者定位。 */
  summary: string;
  reasons: string[];
}

/** 提案 Job 报告：完整记录模型、Prompt 版本、输入证据、产出与拒绝原因。 */
export interface ProposalJobReport<TCreated> {
  kind: "memory" | "skill";
  model: string;
  promptVersion: string;
  inputEvidenceIds: string[];
  created: TCreated[];
  rejected: RejectedCandidate[];
  usage: LlmUsage;
  attempts: number;
  latencyMs: number;
}

