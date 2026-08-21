import type { GovernedStatus } from "./lifecycle.js";

export interface Scope {
  userId: string;
  teamId: string;
  agentId: string;
  sessionId?: string;
}

export interface SourceReference {
  evidenceId: string;
  messageId?: string;
  capturedAt: string;
}

export interface GovernanceMetadata {
  status: GovernedStatus;
  confidence: number;
  createdReason: string;
  createdAt: string;
  updatedAt: string;
  lastVerifiedAt?: string;
  validFrom?: string;
  validUntil?: string;
  sensitivity: "normal" | "sensitive" | "restricted";
  /**
   * Verify 的执行者标记（向后兼容的可选新增字段，旧数据缺省按 manual 解释）：
   * "auto" 表示由用户预配的确定性规则放行（见 governance/auto-verify.ts），
   * "manual" 表示人工审核放行。incorrect/outdated 反馈的自动降级只对 auto 生效。
   * 该字段不参与 feedback 的 assetVersion 计算（版本代次仍以 updatedAt 为准）。
   */
  verifiedBy?: "auto" | "manual";
}

