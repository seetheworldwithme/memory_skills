import type { GovernedStatus } from "./lifecycle.js";

export interface Scope {
  userId: string;
  teamId: string;
  agentId: string;
  sessionId?: string;
}

export interface SourceReference {
  evidenceId: string;
  messageId?: string;
  capturedAt: string;
}

export interface GovernanceMetadata {
  status: GovernedStatus;
  confidence: number;
  createdReason: string;
  createdAt: string;
  updatedAt: string;
  lastVerifiedAt?: string;
  validFrom?: string;
  validUntil?: string;
  sensitivity: "normal" | "sensitive" | "restricted";
}

