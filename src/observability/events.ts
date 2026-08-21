import type { Scope } from "../governance/types.js";
import type { WarningCode } from "../context/contract.js";

/**
 * 诊断与审计事件的版本号。
 * 只允许新增可选字段或新增事件类型；删除或改名字段必须提升版本。
 */
export const EVENT_SCHEMA_VERSION = 1;

export type ObservabilityEventType =
  | "service.started"
  | "context.recall.completed"
  | "context.recall.failed"
  | "retrieval.auto_sync.completed"
  | "retrieval.auto_sync.failed"
  | "event.redacted"
  | "audit.login_failed"
  | "audit.denied"
  | "audit.state_changed"
  | "audit.proposal_run"
  | "governance.auto_verify.evaluated";

/** 事件公共信封字段，所有事件都必须携带。 */
interface EventEnvelope {
  schemaVersion: number;
  eventType: ObservabilityEventType;
  timestamp: string;
}

export interface ServiceStartedEvent extends EventEnvelope {
  eventType: "service.started";
  host: string;
  port: number;
  databasePath: string;
}

/** 召回成功事件：只记录计数、耗时、预算与策略，绝不携带资产正文或查询原文。 */
export interface ContextRecallCompletedEvent extends EventEnvelope {
  eventType: "context.recall.completed";
  requestId: string;
  contractVersion: number;
  /** 检索策略：lexical / hybrid；向后兼容的可选新增字段。 */
  retrievalStrategy?: string;
  scope: Scope;
  durationMs: number;
  queryChars: number;
  includeDraft: boolean;
  memoryCandidates: number;
  memoryReturned: number;
  maxMemoryResults: number;
  maxMemoryChars: number;
  usedMemoryChars: number;
  skillCandidates: number;
  skillReturned: number;
  maxSkillResults: number;
  maxSkillChars: number;
  usedSkillChars: number;
  truncated: boolean;
  warningCodes: WarningCode[];
  matchStrategies: string[];
}

/** 召回失败事件：只记录错误码与错误名，不记录可能拼接用户内容的错误消息。 */
export interface ContextRecallFailedEvent extends EventEnvelope {
  eventType: "context.recall.failed";
  requestId: string;
  scope: Scope;
  durationMs: number;
  queryChars: number;
  errorCode: string;
  errorName: string;
}

/** 禁止值兜底脱敏事件：序列化结果命中禁止值时用它替代原始事件。 */
export interface EventRedactedEvent extends EventEnvelope {
  eventType: "event.redacted";
  originalEventType: ObservabilityEventType;
  reason: "forbidden-value-detected";
}

/** 自动向量同步成功事件：治理状态转换后触发，只携带计数与触发来源，不携带资产正文。 */
export interface RetrievalAutoSyncCompletedEvent extends EventEnvelope {
  eventType: "retrieval.auto_sync.completed";
  /** 触发来源：memory.transition / skill.transition。 */
  trigger: string;
  assetKind: "memory" | "skill";
  assetId: string;
  scope: Scope;
  /** 本次增量实际嵌入的资产数（记忆 + Skill）。 */
  embedded: number;
  /** 本次清理的失效向量行数（记忆 + Skill）。 */
  removed: number;
}

/** 自动向量同步失败事件：同步失败只记事件，不影响治理状态转换本身。 */
export interface RetrievalAutoSyncFailedEvent extends EventEnvelope {
  eventType: "retrieval.auto_sync.failed";
  trigger: string;
  assetKind: "memory" | "skill";
  assetId: string;
  scope: Scope;
  errorCode: string;
  errorName: string;
}

/** 登录失败审计：只记来源与原因，绝不记录提交的凭据值（Task 16）。 */
export interface AuditLoginFailedEvent extends EventEnvelope {
  eventType: "audit.login_failed";
  /** 请求来源地址；本地部署下通常是 127.0.0.1。 */
  remoteAddress: string;
  reason: string;
}

/** 授权拒绝审计（401/403）：谁在哪个端点被什么原因拒绝（Task 16）。 */
export interface AuditDeniedEvent extends EventEnvelope {
  eventType: "audit.denied";
  /** 认证身份的用户 ID；未通过认证的请求记为 anonymous。 */
  userId: string;
  path: string;
  /** 拒绝原因码：UNAUTHORIZED / FORBIDDEN_ACTION / FORBIDDEN_SCOPE。 */
  code: string;
  /** 被拒绝的动作（401 时可能未知，可省略）。 */
  action?: string;
}

/** 治理状态变更审计：谁把哪个资产从什么状态转成什么状态（Task 16）。 */
export interface AuditStateChangedEvent extends EventEnvelope {
  eventType: "audit.state_changed";
  userId: string;
  assetKind: "memory" | "skill" | "evidence";
  assetId: string;
  scope: Scope;
  /** 变更来源端点（memory.transition / skill.rollback / evidence.delete 等）。 */
  trigger: string;
  /** 变更前状态；批量传播或来源不可考时为 unknown。 */
  from: string;
  to: string;
}

/** 模型提案审计：谁触发了一次提案、成功与否（Task 16）。不记 Prompt 与输出正文。 */
export interface AuditProposalRunEvent extends EventEnvelope {
  eventType: "audit.proposal_run";
  userId: string;
  kind: "memory" | "skill";
  ok: boolean;
  errorCode?: string;
}

/**
 * 规则化自动 Verify 评估事件：每次确定性规则评估（无论放行与否）都记录，
 * ruleCodes 是枚举规则码、errorCode 只记错误名，绝不携带资产内容。
 */
export interface GovernanceAutoVerifyEvaluatedEvent extends EventEnvelope {
  eventType: "governance.auto_verify.evaluated";
  assetKind: "memory";
  assetId: string;
  scope: Scope;
  passed: boolean;
  ruleCodes: string[];
  errorCode?: string;
}

export type ObservabilityEvent =
  | ServiceStartedEvent
  | ContextRecallCompletedEvent
  | ContextRecallFailedEvent
  | RetrievalAutoSyncCompletedEvent
  | RetrievalAutoSyncFailedEvent
  | EventRedactedEvent
  | AuditLoginFailedEvent
  | AuditDeniedEvent
  | AuditStateChangedEvent
  | AuditProposalRunEvent
  | GovernanceAutoVerifyEvaluatedEvent;

/**
 * 每种事件允许输出的字段白名单。
 * 序列化时只投影白名单内的键，这是"字段级禁止"的结构性保证：
 * 即使调用方误传了 query、content、accessKey 等字段，也不会进入输出。
 */
const FIELD_ALLOWLIST: Record<ObservabilityEventType, readonly string[]> = {
  "service.started": ["host", "port", "databasePath"],
  "context.recall.completed": [
    "requestId", "contractVersion", "retrievalStrategy", "scope", "durationMs", "queryChars", "includeDraft",
    "memoryCandidates", "memoryReturned", "maxMemoryResults", "maxMemoryChars", "usedMemoryChars",
    "skillCandidates", "skillReturned", "maxSkillResults", "maxSkillChars", "usedSkillChars",
    "truncated", "warningCodes", "matchStrategies",
  ],
  "context.recall.failed": ["requestId", "scope", "durationMs", "queryChars", "errorCode", "errorName"],
  "retrieval.auto_sync.completed": ["trigger", "assetKind", "assetId", "scope", "embedded", "removed"],
  "retrieval.auto_sync.failed": ["trigger", "assetKind", "assetId", "scope", "errorCode", "errorName"],
  "event.redacted": ["originalEventType", "reason"],
  "audit.login_failed": ["remoteAddress", "reason"],
  "audit.denied": ["userId", "path", "code", "action"],
  "audit.state_changed": ["userId", "assetKind", "assetId", "scope", "trigger", "from", "to"],
  "audit.proposal_run": ["userId", "kind", "ok", "errorCode"],
  "governance.auto_verify.evaluated": ["assetKind", "assetId", "scope", "passed", "ruleCodes", "errorCode"],
};

/** 按白名单投影事件并序列化为单行 JSON，供 JSONL 输出使用。 */
export function serializeObservabilityEvent(event: ObservabilityEvent): string {
  const allowed = FIELD_ALLOWLIST[event.eventType] ?? [];
  const projected: Record<string, unknown> = {
    schemaVersion: EVENT_SCHEMA_VERSION,
    eventType: event.eventType,
    timestamp: event.timestamp,
  };
  for (const key of allowed) {
    if (key in event) projected[key] = (event as unknown as Record<string, unknown>)[key];
  }
  return JSON.stringify(projected);
}

/** 从异常中提取稳定错误码：领域错误用自身 code，其余归为 UNEXPECTED。 */
export function errorCodeFor(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error
    && typeof (error as { code: unknown }).code === "string") {
    return (error as { code: string }).code;
  }
  return "UNEXPECTED";
}
