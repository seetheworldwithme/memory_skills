import type { GovernedStatus } from "./lifecycle.js";
import type { Scope } from "./types.js";
import type { SqliteRepository } from "../storage/sqlite-repository.js";
import { NotFoundError } from "../errors.js";

/**
 * 删除影响分析（Task 14）。
 *
 * 删除 Evidence 前先回答"这一删会影响哪些资产"：
 * 只读预览派生 Memory/Skill 及其将被传播到的状态，不给任何静默删除。
 */

export interface EvidenceDeletionImpact {
  evidence: {
    id: string;
    role: string;
    capturedAt: string;
    contentPreview: string;
  };
  memories: Array<{
    id: string;
    status: GovernedStatus;
    contentPreview: string;
    /** 删除后将转换到的状态；null 表示保持不变。 */
    wouldTransitionTo: GovernedStatus | null;
  }>;
  skills: Array<{
    id: string;
    name: string;
    version: number;
    status: GovernedStatus;
    /** 删除后将转换到的状态；null 表示保持不变。 */
    wouldTransitionTo: GovernedStatus | null;
  }>;
  /** 删除后将进入待复核（Deprecated）的 Verified 资产数。 */
  pendingReviewCount: number;
}

export class ImpactAnalysis {
  constructor(private readonly repository: SqliteRepository) {}

  /** 预览删除某条 Evidence 的影响：只读，不做任何变更。 */
  evidenceDeletion(evidenceId: string, scope: Scope): EvidenceDeletionImpact {
    const evidence = this.repository.getEvidenceScoped(evidenceId, scope);
    if (!evidence) throw new NotFoundError(`evidence not found: ${evidenceId}`);

    const memoryRows = this.repository.listMemory(scope)
      .filter((asset) => asset.sources.some((source) => source.evidenceId === evidenceId));
    const memories = memoryRows.map((asset) => ({
      id: asset.id,
      status: asset.governance.status,
      contentPreview: preview(asset.content),
      wouldTransitionTo: asset.governance.status === "verified" ? ("deprecated" as GovernedStatus) : null,
    }));

    const skills = this.repository.listSkills(scope)
      .filter((skill) => skill.sources.some((source) => source.evidenceId === evidenceId))
      .map((skill) => ({
        id: skill.id,
        name: skill.name,
        version: skill.version,
        status: skill.status,
        wouldTransitionTo: skill.status === "verified" ? ("deprecated" as GovernedStatus) : null,
      }));

    return {
      evidence: {
        id: evidence.id,
        role: evidence.role,
        capturedAt: evidence.capturedAt,
        contentPreview: preview(evidence.content),
      },
      memories,
      skills,
      pendingReviewCount: [...memories, ...skills].filter((item) => item.wouldTransitionTo === "deprecated").length,
    };
  }
}

function preview(content: string): string {
  const flattened = content.replace(/\s+/g, " ").trim();
  return flattened.length > 80 ? `${flattened.slice(0, 80)}…` : flattened;
}
