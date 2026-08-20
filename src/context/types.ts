import type { Scope } from "../governance/types.js";
import type { RecalledMemory } from "../memory/types.js";
import type { SkillDocument } from "../skills/types.js";

export interface ContextRecallInput {
  query: string;
  scope: Scope;
  includeDraft?: boolean;
  maxMemoryResults?: number;
  maxMemoryChars?: number;
  maxSkillResults?: number;
  maxSkillChars?: number;
}

export interface RecalledSkill extends SkillDocument {
  truncated: boolean;
}

/**
 * @deprecated Use {@link "./contract.js".ContextRecallResponse} instead.
 * `recall` now returns the versioned contract envelope.
 */
export interface RecalledContext {
  query: string;
  scope: Scope;
  memories: RecalledMemory[];
  skills: RecalledSkill[];
}
