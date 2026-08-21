import type { Migration } from "../migration-runner.js";
import { migration001Core } from "./001-core.js";
import { migration002Feedback } from "./002-feedback.js";
import { migration003SkillRuns } from "./003-skill-runs.js";
import { migration004SkillVersionStatus } from "./004-skill-version-status.js";
import { migration005EvidenceOriginSession } from "./005-evidence-origin-session.js";
import { migration006RecallLog } from "./006-recall-log.js";

/**
 * 迁移注册表：唯一事实来源，新增 Schema 变更只允许追加（单向），不修改历史迁移。
 * id 必须从 1 连续递增；runner 初始化时校验。
 */
export const MIGRATIONS: readonly Migration[] = [
  migration001Core,
  migration002Feedback,
  migration003SkillRuns,
  migration004SkillVersionStatus,
  migration005EvidenceOriginSession,
  migration006RecallLog,
];

export const LATEST_SCHEMA_VERSION = MIGRATIONS.length;
