import type { GovernedStatus } from "../governance/lifecycle.js";
import type { Scope, SourceReference } from "../governance/types.js";

export interface SkillDocument {
  id: string;
  scope: Scope;
  name: string;
  description: string;
  content: string;
  version: number;
  status: GovernedStatus;
  sources: SourceReference[];
  createdAt: string;
  updatedAt: string;
}

