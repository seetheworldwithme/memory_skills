import type { Scope } from "../governance/types.js";
import type { Evidence, MemoryLayer } from "../memory/types.js";

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

