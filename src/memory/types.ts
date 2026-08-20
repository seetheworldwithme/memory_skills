import type { GovernanceMetadata, Scope, SourceReference } from "../governance/types.js";

export type MemoryLayer = "l1" | "l2" | "l3";
export type EvidenceRole = "user" | "assistant" | "system" | "tool";

export interface Evidence {
  id: string;
  scope: Scope;
  role: EvidenceRole;
  content: string;
  capturedAt: string;
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
}

