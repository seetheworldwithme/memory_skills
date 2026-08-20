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
  | "event.redacted";

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

export type ObservabilityEvent =
  | ServiceStartedEvent
  | ContextRecallCompletedEvent
  | ContextRecallFailedEvent
  | EventRedactedEvent;

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
  "event.redacted": ["originalEventType", "reason"],
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
