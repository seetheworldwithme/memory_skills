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

/** 召回日志中的单个命中：资产 ID 与当时的匹配分数（分数可能缺省）。 */
export interface RecallLogHit {
  id: string;
  score?: number;
}

/**
 * 召回日志条目：持久化 requestId → 查询/命中资产的关联，
 * 服务于反馈回流评测集与采用率统计。
 * 隐私边界：只存本地 SQLite（与 evidence 同级），不进观测事件与 API 响应。
 * 刻意不加资产外键：资产删除后日志仍保留作评测依据（同 feedback 的取舍）。
 */
export interface RecallLogRecord {
  requestId: string;
  query: string;
  scope: Scope;
  /** 检索策略：lexical / hybrid；旧数据可能缺省。 */
  retrievalStrategy?: string;
  memoryHits: RecallLogHit[];
  skillHits: RecallLogHit[];
  durationMs?: number;
  createdAt: string;
}
