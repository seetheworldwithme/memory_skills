import type { Scope } from "../governance/types.js";

/** 显式反馈四分类：有用 / 无关 / 错误 / 过期。 */
export const FEEDBACK_KINDS = ["useful", "irrelevant", "incorrect", "outdated"] as const;
export type FeedbackKind = (typeof FEEDBACK_KINDS)[number];

export type FeedbackAssetKind = "memory" | "skill";

/**
 * 显式反馈记录：关联召回 requestId 与资产版本，用于评测与治理建议。
 * 反馈只是人工判断的采集，不会自动改写资产内容或状态。
 */
export interface FeedbackRecord {
  id: string;
  assetKind: FeedbackAssetKind;
  assetId: string;
  /**
   * 反馈针对的资产版本：Skill 为版本号；Memory 没有独立版本字段，
   * 以 governance.updatedAt 作为内容代次标识，保证后续内容变更可区分。
   */
  assetVersion: string;
  kind: FeedbackKind;
  scope: Scope;
  /** 关联的召回请求 ID（context recall 响应中的 requestId）；直接浏览资产时可缺省。 */
  requestId?: string;
  /** 自由文本备注，可选。 */
  comment?: string;
  createdAt: string;
}

/** 反馈四分类的中文标签：Web 展示与文档共用，避免散落硬编码。 */
export const FEEDBACK_KIND_LABELS: Readonly<Record<FeedbackKind, string>> = {
  useful: "有用",
  irrelevant: "无关",
  incorrect: "错误",
  outdated: "过期",
};
