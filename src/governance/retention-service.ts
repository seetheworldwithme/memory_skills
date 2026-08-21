import { transitionStatus, type GovernedStatus } from "./lifecycle.js";
import type { Scope } from "./types.js";
import type { MemoryAsset } from "../memory/types.js";
import type { SqliteRepository } from "../storage/sqlite-repository.js";
import { NotFoundError } from "../errors.js";

/**
 * 过期与保留策略（Task 14）。
 *
 * 治理边界：过期只降权/待复核，绝不物理删除；
 * 降权指 Verified → Deprecated（退出召回，可通过续期恢复），
 * 续期是用户显式确认"仍然有效"，恢复有效期并回到 Verified。
 */

/** 待复核条目：过期或长期未验证的资产。 */
export interface RetentionReviewItem {
  id: string;
  kind: "memory" | "skill";
  status: GovernedStatus;
  /** 内容预览。 */
  preview: string;
  /** 过期时间（仅过期条目有）。 */
  validUntil?: string;
  /** 最近一次 Verify 时间（可能缺省）。 */
  lastVerifiedAt?: string;
  updatedAt: string;
}

export interface RetentionReview {
  /** 已过有效期但仍处于 Verified 的记忆（可降权待复核或续期）。 */
  expiredMemories: RetentionReviewItem[];
  /** 超过 staleDays 未再验证的 Verified 记忆（仅提示，不自动动作）。 */
  staleMemories: RetentionReviewItem[];
  /** 超过 staleDays 未更新的 Verified Skill（仅提示，不自动动作）。 */
  staleSkills: RetentionReviewItem[];
  generatedAt: string;
}

/** 长期未验证的默认阈值：90 天。 */
export const DEFAULT_STALE_DAYS = 90;

export class RetentionService {
  constructor(
    private readonly repository: SqliteRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * 待复核清单：过期记忆 + 长期未验证资产。
   * 只读扫描，不改变任何资产状态。
   */
  review(scope: Scope, options: { staleDays?: number } = {}): RetentionReview {
    const staleDays = options.staleDays ?? DEFAULT_STALE_DAYS;
    if (!Number.isInteger(staleDays) || staleDays <= 0) throw new Error("staleDays must be a positive integer");
    const now = this.now().toISOString();
    const staleCutoff = new Date(this.now().getTime() - staleDays * 24 * 60 * 60 * 1000).toISOString();

    const expiredMemories: RetentionReviewItem[] = [];
    const staleMemories: RetentionReviewItem[] = [];
    for (const asset of this.repository.listMemory(scope)) {
      if (asset.governance.status !== "verified") continue;
      const item = toMemoryItem(asset);
      if (asset.governance.validUntil && asset.governance.validUntil < now) {
        expiredMemories.push(item);
        continue;
      }
      const lastActivity = asset.governance.lastVerifiedAt ?? asset.governance.updatedAt;
      if (lastActivity < staleCutoff) staleMemories.push(item);
    }

    const staleSkills: RetentionReviewItem[] = this.repository.listSkills(scope)
      .filter((skill) => skill.status === "verified" && skill.updatedAt < staleCutoff)
      .map((skill) => ({
        id: skill.id,
        kind: "skill" as const,
        status: skill.status,
        preview: preview(`${skill.name}：${skill.description}`),
        updatedAt: skill.updatedAt,
      }));

    return {
      expiredMemories,
      staleMemories,
      staleSkills,
      generatedAt: now,
    };
  }

  /**
   * 降权过期记忆：validUntil 已过且仍为 Verified 的资产转为 Deprecated（待复核）。
   * 物理上什么都不会被删除；用户确认后可续期恢复。返回实际发生的转换。
   */
  deprecateExpired(scope: Scope): { memories: Array<{ id: string; from: GovernedStatus; to: GovernedStatus }> } {
    const now = this.now().toISOString();
    const transitions: Array<{ id: string; from: GovernedStatus; to: GovernedStatus }> = [];
    for (const asset of this.repository.listMemory(scope)) {
      if (asset.governance.status !== "verified") continue;
      if (!asset.governance.validUntil || asset.governance.validUntil >= now) continue;
      const to = transitionStatus("verified", "deprecated");
      this.repository.updateMemoryStatus(asset.id, to, now);
      transitions.push({ id: asset.id, from: "verified", to });
    }
    return { memories: transitions };
  }

  /**
   * 续期（用户确认仍然有效）：
   * 更新有效期（显式传新期限，或传 null 清除期限表示长期有效）；
   * 若资产此前因过期被降权为 Deprecated，自动恢复为 Verified。
   * 只允许 Verified/Deprecated 资产续期。
   */
  renewMemory(id: string, scope: Scope, input: { validUntil?: string | null }): MemoryAsset {
    const asset = this.repository.getMemoryScoped(id, scope);
    if (!asset) throw new NotFoundError(`memory not found: ${id}`);
    if (asset.governance.status !== "verified" && asset.governance.status !== "deprecated") {
      throw new Error(`cannot renew ${asset.governance.status} memory; only verified or deprecated assets can be renewed`);
    }
    if (input.validUntil === undefined) {
      throw new Error("validUntil is required: pass an ISO date to extend, or null to remove the expiry");
    }
    const now = this.now().toISOString();
    const updated = this.repository.updateMemoryValidity(id, { validUntil: input.validUntil }, now);
    const effectiveUntil = input.validUntil ?? null;
    if (updated.governance.status === "deprecated" && (effectiveUntil === null || effectiveUntil > now)) {
      return this.repository.updateMemoryStatus(id, transitionStatus("deprecated", "verified"), now);
    }
    return updated;
  }
}

function toMemoryItem(asset: MemoryAsset): RetentionReviewItem {
  return {
    id: asset.id,
    kind: "memory",
    status: asset.governance.status,
    preview: preview(asset.content),
    ...(asset.governance.validUntil ? { validUntil: asset.governance.validUntil } : {}),
    ...(asset.governance.lastVerifiedAt ? { lastVerifiedAt: asset.governance.lastVerifiedAt } : {}),
    updatedAt: asset.governance.updatedAt,
  };
}

function preview(content: string): string {
  const flattened = content.replace(/\s+/g, " ").trim();
  return flattened.length > 60 ? `${flattened.slice(0, 60)}…` : flattened;
}
