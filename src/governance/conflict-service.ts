import type { Scope } from "./types.js";
import type { SqliteRepository } from "../storage/sqlite-repository.js";
import { normalizeForDedup } from "../extraction/validators.js";
import { retrievalTerms } from "../retrieval/text-match.js";

/**
 * 冲突与重复检测（Task 14）。
 *
 * 只做确定性检测，不调用模型：
 * - 重复（duplicate）：归一化内容完全一致，或短者完整包含在长者中；
 * - 疑似冲突（conflict）：检索词重合度高但内容不同（主题相同、说法矛盾）。
 * 检测结果只生成治理任务（人审核后用既有的 Reject/归档/合并动作处置），
 * 本服务不修改任何资产。任务按需计算、ID 确定性：处置完资产后任务自然消失。
 */

export type GovernanceTaskKind = "duplicate" | "conflict";

export interface GovernanceTaskAsset {
  id: string;
  /** 内容预览（截断），帮助人在任务列表里直接认出资产。 */
  preview: string;
  /** Skill 的名称；Memory 任务中缺省。 */
  name?: string;
}

export interface GovernanceTask {
  /** 确定性 ID：kind + 排序后的资产 ID，同一对资产重复扫描不会产生新任务。 */
  id: string;
  kind: GovernanceTaskKind;
  assetKind: "memory" | "skill";
  /** 涉及的资产 ID（按字典序排序），便于断言与快捷跳转。 */
  assetIds: string[];
  assets: GovernanceTaskAsset[];
  /** 中文说明：为什么判定为重复/疑似冲突。 */
  detail: string;
  /** 建议的处置动作（仍由人执行）。 */
  suggestion: string;
}

/** 疑似冲突的检索词重合度阈值（交集 ÷ 较小集合大小）：低于它视为主题不同。 */
const CONFLICT_OVERLAP_THRESHOLD = 0.6;
/** 视为"高度重复"的包含关系所需的最短归一化长度，避免短句误报。 */
const MIN_CONTAINMENT_LENGTH = 12;
/** 任务详情中的内容预览长度。 */
const PREVIEW_CHARS = 40;

export class ConflictService {
  constructor(private readonly repository: SqliteRepository) {}

  /** 扫描同一作用域内的 Verified 资产，生成重复/冲突治理任务（确定性排序）。 */
  listTasks(scope: Scope): GovernanceTask[] {
    const memories = this.repository.listMemory(scope)
      .filter((asset) => asset.governance.status === "verified");
    const skills = this.repository.listSkills(scope)
      .filter((skill) => skill.status === "verified");

    const tasks: GovernanceTask[] = [];
    // 记忆以全文比较；Skill 以正文章节比较（frontmatter 的 name/description
    // 不同本来就是不同 Skill，重复的判定信号是"教了同一套步骤"）
    tasks.push(...detectPairTasks("memory", memories.map((asset) => ({
      id: asset.id,
      text: asset.content,
      preview: preview(asset.content),
    }))));
    tasks.push(...detectPairTasks("skill", skills.map((skill) => ({
      id: skill.id,
      name: skill.name,
      text: stripFrontmatter(skill.content),
      preview: preview(skill.description),
    }))));
    return tasks.sort((a, b) => a.id.localeCompare(b.id));
  }
}

/** 两两比较同一类资产，产出重复/冲突任务。 */
function detectPairTasks(
  assetKind: "memory" | "skill",
  assets: ReadonlyArray<{ id: string; name?: string; text: string; preview: string }>,
): GovernanceTask[] {
  const normalized = new Map(assets.map((asset) => [asset.id, normalizeForDedup(asset.text)]));
  const terms = new Map(assets.map((asset) => [asset.id, new Set(retrievalTerms(asset.text))]));

  const tasks: GovernanceTask[] = [];
  for (let i = 0; i < assets.length; i += 1) {
    for (let j = i + 1; j < assets.length; j += 1) {
      const left = assets[i]!;
      const right = assets[j]!;
      const relation = classify(
        normalized.get(left.id)!,
        normalized.get(right.id)!,
        terms.get(left.id)!,
        terms.get(right.id)!,
      );
      if (relation === "none") continue;
      tasks.push(buildTask(relation, assetKind, [left, right]));
    }
  }
  return tasks;
}

function classify(
  leftNormalized: string,
  rightNormalized: string,
  leftTerms: ReadonlySet<string>,
  rightTerms: ReadonlySet<string>,
): GovernanceTaskKind | "none" {
  if (leftNormalized === rightNormalized) return "duplicate";
  const [shorter, longer] = leftNormalized.length <= rightNormalized.length
    ? [leftNormalized, rightNormalized]
    : [rightNormalized, leftNormalized];
  if (shorter.length >= MIN_CONTAINMENT_LENGTH && longer.includes(shorter)) return "duplicate";
  if (overlap(leftTerms, rightTerms) >= CONFLICT_OVERLAP_THRESHOLD) return "conflict";
  return "none";
}

/**
 * 重合度 = 交集 ÷ 较小集合大小。
 * 用它而不是 Jaccard 的原因：矛盾句往往共享一长段公共前缀（主题相同），
 * 只有结尾不同，Jaccard 会被两段不同的尾巴稀释，重合度不会。
 */
function overlap(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const term of a) {
    if (b.has(term)) intersection += 1;
  }
  return intersection / Math.min(a.size, b.size);
}

function buildTask(
  kind: GovernanceTaskKind,
  assetKind: "memory" | "skill",
  pair: ReadonlyArray<{ id: string; name?: string; preview: string }>,
): GovernanceTask {
  const ordered = [...pair].sort((a, b) => a.id.localeCompare(b.id));
  const assetIds = ordered.map((asset) => asset.id);
  const label = ordered.map((asset) => asset.name ?? asset.id).join(" 与 ");
  if (kind === "duplicate") {
    return {
      id: `duplicate:${assetKind}:${assetIds.join("+")}`,
      kind,
      assetKind,
      assetIds,
      assets: ordered.map((asset) => ({ id: asset.id, preview: asset.preview, ...(asset.name ? { name: asset.name } : {}) })),
      detail: `${label} 内容高度重复（归一化后一致或互相包含），会占用召回预算并稀释排序`,
      suggestion: "保留一条（通常信息更全或更近更新），另一条改为 Deprecated 或归档；如信息互补则合并成一条",
    };
  }
  return {
    id: `conflict:${assetKind}:${assetIds.join("+")}`,
    kind,
    assetKind,
    assetIds,
    assets: ordered.map((asset) => ({ id: asset.id, preview: asset.preview, ...(asset.name ? { name: asset.name } : {}) })),
    detail: `${label} 主题高度重合但内容不同，可能相互矛盾，同时召回会让 Agent 收到冲突指令`,
    suggestion: "对照来源证据确认哪条是当前有效说法，另一条改为 Deprecated 或拒绝；必要时合并为一条覆盖两种情况",
  };
}

/** 去掉 SKILL.md 的 frontmatter 头，只保留正文章节参与比较。 */
function stripFrontmatter(content: string): string {
  return content.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "");
}

function preview(content: string): string {
  const flattened = content.replace(/\s+/g, " ").trim();
  return flattened.length > PREVIEW_CHARS ? `${flattened.slice(0, PREVIEW_CHARS)}…` : flattened;
}
