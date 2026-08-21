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

/**
 * Skill 历史版本记录（skill_versions 表的领域视图）。
 * status 是"该版本内容被替换时的治理状态快照"：当前版本随治理转换更新，
 * 历史版本停留在被替换前的状态；数据库升级前的历史版本可能为 null（未知）。
 */
export interface SkillVersionRecord {
  skillId: string;
  version: number;
  content: string;
  status: GovernedStatus | null;
  createdAt: string;
}

