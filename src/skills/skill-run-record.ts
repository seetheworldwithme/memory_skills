import { randomUUID } from "node:crypto";

import { NotFoundError } from "../errors.js";
import type { Scope } from "../governance/types.js";
import type { SqliteRepository } from "../storage/sqlite-repository.js";

/**
 * Skill 使用记录（Task 13）。
 *
 * "没有证据时不宣称 Skill 有效"的落地：Skill 是否真的有帮助，
 * 只能由被召回、被采用、任务结果和用户反馈这些使用证据回答。
 * 本模块只负责采集与汇总，不对资产状态做任何自动变更。
 */

/** 使用事件四类：被召回 / 被采用 / 任务成功 / 任务失败。 */
export const SKILL_RUN_EVENTS = ["recalled", "adopted", "succeeded", "failed"] as const;
export type SkillRunEventKind = (typeof SKILL_RUN_EVENTS)[number];

/** 事件中文标签：Web 展示与文档共用。 */
export const SKILL_RUN_EVENT_LABELS: Readonly<Record<SkillRunEventKind, string>> = {
  recalled: "被召回",
  adopted: "被采用",
  succeeded: "任务成功",
  failed: "任务失败",
};

export interface SkillRunRecord {
  id: string;
  skillId: string;
  /** 记录发生时 Skill 的当前版本，保证历史记录可区分代次。 */
  skillVersion: number;
  scope: Scope;
  event: SkillRunEventKind;
  /** 关联的召回请求 ID（context recall 响应中的 requestId），可选。 */
  requestId?: string;
  /** 自由文本备注（任务结果摘要等），可选。 */
  note?: string;
  createdAt: string;
}

/** 使用效果结论：只依据落库的使用证据计算，不做任何推测。 */
export type SkillRunVerdict = "no-evidence" | "supported" | "mixed" | "contradicted";

export interface SkillRunSummary {
  skillId: string;
  /** 当前版本号（使用记录可能跨版本累计）。 */
  version: number;
  runs: Record<SkillRunEventKind, number>;
  /** 关联到该 Skill 的显式反馈计数（四分类）。 */
  feedback: { useful: number; irrelevant: number; incorrect: number; outdated: number };
  verdict: SkillRunVerdict;
  /** 中文结论，供列表直接展示。 */
  verdictLabel: string;
  /** 是否存在任何使用记录（含反馈）。 */
  hasEvidence: boolean;
}

const VERDICT_LABELS: Readonly<Record<SkillRunVerdict, string>> = {
  "no-evidence": "暂无使用记录，不宣称该 Skill 有效",
  supported: "有正向使用证据支撑",
  mixed: "使用证据不足或互有出入，暂不下结论",
  contradicted: "使用记录偏向失败，建议复核",
};

export class SkillRunRecorder {
  constructor(
    private readonly repository: SqliteRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** 记录一次使用事件：Skill 必须存在于该作用域，事件四选一。 */
  record(input: {
    skillId: string;
    scope: Scope;
    event: SkillRunEventKind;
    requestId?: string;
    note?: string;
    id?: string;
  }): SkillRunRecord {
    if (!SKILL_RUN_EVENTS.includes(input.event)) {
      throw new Error(`event must be one of: ${SKILL_RUN_EVENTS.join(", ")}`);
    }
    const skill = this.repository.getSkill(input.skillId);
    if (!skill || !sameScope(skill.scope, input.scope)) {
      throw new NotFoundError(`skill not found: ${input.skillId}`);
    }
    const record: SkillRunRecord = {
      id: input.id ?? randomUUID(),
      skillId: input.skillId,
      skillVersion: skill.version,
      scope: input.scope,
      event: input.event,
      ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
      ...(input.note === undefined ? {} : { note: input.note }),
      createdAt: this.now().toISOString(),
    };
    return this.repository.insertSkillRun(record);
  }

  /**
   * 使用效果汇总：使用事件计数 + 显式反馈计数 + 确定性结论。
   * 结论规则完全可解释：没有任何记录 → no-evidence；
   * 成功多于失败且负面反馈不占优 → supported；
   * 失败不少于成功 → contradicted；其余 → mixed。
   */
  summary(skillId: string, scope: Scope): SkillRunSummary {
    const skill = this.repository.getSkill(skillId);
    if (!skill || !sameScope(skill.scope, scope)) {
      throw new NotFoundError(`skill not found: ${skillId}`);
    }
    const runCounts = this.repository.countSkillRuns(skillId);
    const feedback = this.repository.countFeedbackByKind("skill", skillId, scope);
    const runs: Record<SkillRunEventKind, number> = {
      recalled: runCounts.recalled ?? 0,
      adopted: runCounts.adopted ?? 0,
      succeeded: runCounts.succeeded ?? 0,
      failed: runCounts.failed ?? 0,
    };
    const hasEvidence = Object.values(runs).some((count) => count > 0)
      || Object.values(feedback).some((count) => count > 0);
    return {
      skillId,
      version: skill.version,
      runs,
      feedback,
      verdict: verdictFor(runs, feedback),
      verdictLabel: VERDICT_LABELS[verdictFor(runs, feedback)],
      hasEvidence,
    };
  }
}

function verdictFor(
  runs: Record<SkillRunEventKind, number>,
  feedback: { useful: number; incorrect: number },
): SkillRunVerdict {
  if (!Object.values(runs).some((count) => count > 0)
    && !Object.values(feedback).some((count) => count > 0)) {
    return "no-evidence";
  }
  if (runs.succeeded > 0 && runs.failed < runs.succeeded && feedback.useful >= feedback.incorrect) {
    return "supported";
  }
  if (runs.failed >= runs.succeeded && runs.failed > 0) {
    return "contradicted";
  }
  return "mixed";
}

function sameScope(a: Scope, b: Scope): boolean {
  return a.userId === b.userId
    && a.teamId === b.teamId
    && a.agentId === b.agentId
    && (a.sessionId ?? null) === (b.sessionId ?? null);
}
