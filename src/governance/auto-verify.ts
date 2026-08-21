import type { FeedbackKind } from "../feedback/types.js";
import type { Evidence, EvidenceRole, MemoryLayer } from "../memory/types.js";
import type { GovernanceMetadata } from "./types.js";

/**
 * 规则化自动 Verify（方向 A）：全部规则都是确定性代码路径，配置由用户
 * 通过环境变量预先设置；模型输出（confidence 除外，它是提案元数据而非内容）
 * 不参与发布判定。发布决策来自用户预配的规则，不是模型自我批准——
 * 这是治理路线图 5.2 节"L1 满足严格条件可自动晋升"的落地实现。
 * 本模块的形态与 extraction/interfaces.ts 预留的 ProposalReviewPolicy 对应，
 * 但发布决策归属治理层，因此放在 governance 下而非 extraction 反向依赖。
 */

/** 自动 Verify 配置：enabled=false 表示规则关闭（默认），提案只产 Draft。 */
export type AutoVerifyConfig = {
  enabled: false;
} | {
  enabled: true;
  /** 候选置信度下限（提案元数据），默认 0.8。 */
  minConfidence: number;
  /** 允许自动晋升的资产层级，默认 ["l1"]（具体事实与偏好）。 */
  layers: readonly MemoryLayer[];
  /** 允许作为来源的证据角色白名单，默认 ["user"]（用户原话）。 */
  allowedEvidenceRoles: readonly EvidenceRole[];
  /** Draft 内容与证据原文的最低重合度（字符 bigram 覆盖率），默认 0.8。 */
  minOverlap: number;
  /** 是否要求证据来自 >=2 个独立会话（origin_session_id 去重计数），默认 false。 */
  requireMultiSession: boolean;
};

/** 各环境变量的缺省值：刻意保守，只放行"用户原话的忠实抽取"。 */
const DEFAULT_MIN_CONFIDENCE = 0.8;
const DEFAULT_LAYERS: readonly MemoryLayer[] = ["l1"];
const DEFAULT_EVIDENCE_ROLES: readonly EvidenceRole[] = ["user"];
const DEFAULT_MIN_OVERLAP = 0.8;

/**
 * 从环境变量解析配置。失败安全红线：任何缺失/非法取值一律降级为
 * enabled=false（规则全关、只产 Draft），绝不因配置错误放行资产。
 */
export function resolveAutoVerifyConfigFromEnv(env: Record<string, string | undefined>): AutoVerifyConfig {
  if (env.MEMORY_SKILLS_AUTO_VERIFY !== "rules") return { enabled: false };
  const minConfidence = parseUnitInterval(env.MEMORY_SKILLS_AUTO_VERIFY_MIN_CONFIDENCE) ?? DEFAULT_MIN_CONFIDENCE;
  const minOverlap = parseUnitInterval(env.MEMORY_SKILLS_AUTO_VERIFY_MIN_OVERLAP) ?? DEFAULT_MIN_OVERLAP;
  const layers = parseLayers(env.MEMORY_SKILLS_AUTO_VERIFY_LAYERS) ?? DEFAULT_LAYERS;
  const allowedEvidenceRoles = parseEvidenceRoles(env.MEMORY_SKILLS_AUTO_VERIFY_EVIDENCE_ROLES) ?? DEFAULT_EVIDENCE_ROLES;
  const requireMultiSession = parseBoolean(env.MEMORY_SKILLS_AUTO_VERIFY_REQUIRE_MULTI_SESSION);
  return { enabled: true, minConfidence, layers, allowedEvidenceRoles, minOverlap, requireMultiSession };
}

/** 单条 Draft 的评估输入：资产治理元数据 + 已按作用域取出的来源证据原文。 */
export interface AutoVerifyInput {
  kind: "memory" | "skill";
  layer: MemoryLayer;
  confidence: number;
  sensitivity: GovernanceMetadata["sensitivity"];
  content: string;
  evidence: readonly Evidence[];
}

/** 未通过时的规则码枚举：用于事件与测试断言，绝不携带资产内容。 */
export type AutoVerifyRuleCode =
  | "kind_not_supported"
  | "sensitivity_not_normal"
  | "layer_not_allowed"
  | "low_confidence"
  | "evidence_role_not_allowed"
  | "low_overlap"
  | "single_session";

/** 评估结果：passed=false 时 ruleCodes 说明命中的否决规则（可能多条）。 */
export interface AutoVerifyEvaluation {
  passed: boolean;
  ruleCodes: AutoVerifyRuleCode[];
}

/** 确定性规则评估：逐条检查，全部通过才放行。 */
export function evaluateAutoVerify(config: AutoVerifyConfig & { enabled: true }, input: AutoVerifyInput): AutoVerifyEvaluation {
  // v1 只对 memory 开放；Skill 是可执行指令，爆炸半径大，永远人工审核
  if (input.kind !== "memory") return { passed: false, ruleCodes: ["kind_not_supported"] };

  const ruleCodes: AutoVerifyRuleCode[] = [];
  if (input.sensitivity !== "normal") ruleCodes.push("sensitivity_not_normal");
  if (!config.layers.includes(input.layer)) ruleCodes.push("layer_not_allowed");
  if (input.confidence < config.minConfidence) ruleCodes.push("low_confidence");

  if (input.evidence.length === 0) {
    // 没有来源证据：角色与重合度两条规则都无法满足
    ruleCodes.push("evidence_role_not_allowed", "low_overlap");
    if (config.requireMultiSession) ruleCodes.push("single_session");
    return { passed: false, ruleCodes };
  }

  const roles = new Set(input.evidence.map((item) => item.role));
  if ([...roles].some((role) => !config.allowedEvidenceRoles.includes(role))) {
    ruleCodes.push("evidence_role_not_allowed");
  }
  if (contentOverlap(input.content, input.evidence.map((item) => item.content)) < config.minOverlap) {
    ruleCodes.push("low_overlap");
  }
  if (config.requireMultiSession && countDistinctSessions(input.evidence) < 2) {
    ruleCodes.push("single_session");
  }
  return { passed: ruleCodes.length === 0, ruleCodes };
}

/**
 * Draft 内容对证据原文的字符 bigram 覆盖率：
 * 归一化（NFKC/小写/去空白与标点）后，统计 Draft 的 bigram 有多少
 * 出现在任一证据的 bigram 集合中。忠实抽取（逐字引用）接近 1.0，
 * 模型改写/发挥会显著拉低。Draft 归一化后不足 2 字符时按 0 处理（失败安全）。
 */
export function contentOverlap(draft: string, evidenceTexts: readonly string[]): number {
  const draftBigrams = bigrams(normalize(draft));
  if (draftBigrams.size === 0) return 0;
  const evidenceBigrams = new Set<string>();
  for (const text of evidenceTexts) {
    for (const gram of bigrams(normalize(text))) evidenceBigrams.add(gram);
  }
  let covered = 0;
  for (const gram of draftBigrams) {
    if (evidenceBigrams.has(gram)) covered += 1;
  }
  return covered / draftBigrams.size;
}

/**
 * 反馈降级判定（方向 D 的核心约束）：只有 incorrect/outdated 反馈命中
 * **规则自动 Verify（verifiedBy=auto）** 的资产才允许自动降级为
 * deprecated（待复核，可人工恢复）；人工 Verify 的资产不受反馈自动影响。
 */
export function shouldAutoDeprecateFromFeedback(governance: GovernanceMetadata, kind: FeedbackKind): boolean {
  return (kind === "incorrect" || kind === "outdated")
    && governance.status === "verified"
    && governance.verifiedBy === "auto";
}

/** 统计证据覆盖的独立会话数：origin_session_id 去重（空值不计入）。 */
function countDistinctSessions(evidence: readonly Evidence[]): number {
  const sessions = new Set<string>();
  for (const item of evidence) {
    if (item.originSessionId) sessions.add(item.originSessionId);
  }
  return sessions.size;
}

/** 归一化：NFKC 规整全半角、小写、去全部空白与标点符号，只留实质字符。 */
function normalize(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
}

/** 字符 bigram 集合：归一化文本长度不足 2 时为空集。 */
function bigrams(normalized: string): Set<string> {
  const grams = new Set<string>();
  for (let i = 0; i + 1 < normalized.length; i += 1) {
    grams.add(normalized.slice(i, i + 2));
  }
  return grams;
}

/** 解析 [0,1] 区间的小数；缺失或非法返回 undefined（由调用方回退缺省值）。 */
function parseUnitInterval(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) return undefined;
  return parsed;
}

/** 解析允许的资产层级列表（逗号分隔）；出现任何非法值则整体回退缺省。 */
function parseLayers(value: string | undefined): readonly MemoryLayer[] | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const layers = value.split(",").map((item) => item.trim()).filter(Boolean);
  const valid: MemoryLayer[] = [];
  for (const layer of layers) {
    if (layer !== "l1" && layer !== "l2" && layer !== "l3") return undefined;
    valid.push(layer);
  }
  return valid.length > 0 ? valid : undefined;
}

/** 解析允许的证据角色列表（逗号分隔）；出现任何非法值则整体回退缺省。 */
function parseEvidenceRoles(value: string | undefined): readonly EvidenceRole[] | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const roles = value.split(",").map((item) => item.trim()).filter(Boolean);
  const valid: EvidenceRole[] = [];
  for (const role of roles) {
    if (role !== "user" && role !== "assistant" && role !== "system" && role !== "tool") return undefined;
    valid.push(role);
  }
  return valid.length > 0 ? valid : undefined;
}

/** 解析布尔开关："1"/"true" 视为开，其余视为关。 */
function parseBoolean(value: string | undefined): boolean {
  return value === "1" || value === "true";
}
