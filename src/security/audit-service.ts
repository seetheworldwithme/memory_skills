import type { Scope } from "../governance/types.js";
import { EVENT_SCHEMA_VERSION, type AuditDeniedEvent, type AuditLoginFailedEvent, type AuditProposalRunEvent, type AuditStateChangedEvent } from "../observability/events.js";
import type { EventSink } from "../observability/event-sink.js";
import type { Principal } from "../auth/principal.js";

/**
 * 审计服务（Task 16）：把"谁在何时对什么做了什么"写入事件通道。
 * 审计范围：登录失败、授权拒绝（401/403）、治理状态变更、模型提案。
 * 结构性红线：事件字段在 observability/events.ts 的 FIELD_ALLOWLIST 白名单投影，
 * 即使误传密钥或资产正文也不会进入输出；自由文本字段一律先过 redactText。
 */
export class AuditService {
  readonly #sink: EventSink;

  constructor(sink: EventSink) {
    this.#sink = sink;
  }

  /** 登录失败：只记来源地址与原因，提交的凭据值绝不进入事件。 */
  loginFailed(input: { remoteAddress: string; reason: string }): void {
    const event: AuditLoginFailedEvent = {
      schemaVersion: EVENT_SCHEMA_VERSION,
      eventType: "audit.login_failed",
      timestamp: new Date().toISOString(),
      remoteAddress: input.remoteAddress,
      reason: input.reason,
    };
    this.#sink.emit(event);
  }

  /** 授权拒绝：401 时身份未知记 anonymous，403 时带认证身份与被拒动作。 */
  denied(input: { principal?: Principal; path: string; code: string; action?: string }): void {
    const event: AuditDeniedEvent = {
      schemaVersion: EVENT_SCHEMA_VERSION,
      eventType: "audit.denied",
      timestamp: new Date().toISOString(),
      userId: input.principal?.userId ?? "anonymous",
      path: input.path,
      code: input.code,
      ...(input.action === undefined ? {} : { action: input.action }),
    };
    this.#sink.emit(event);
  }

  /** 治理状态变更：谁把哪个资产从什么状态转成什么状态，批量传播逐资产记录。 */
  stateChanged(input: {
    principal: Principal;
    assetKind: "memory" | "skill" | "evidence";
    assetId: string;
    scope: Scope;
    trigger: string;
    from: string;
    to: string;
  }): void {
    const event: AuditStateChangedEvent = {
      schemaVersion: EVENT_SCHEMA_VERSION,
      eventType: "audit.state_changed",
      timestamp: new Date().toISOString(),
      userId: input.principal.userId,
      assetKind: input.assetKind,
      assetId: input.assetId,
      scope: input.scope,
      trigger: input.trigger,
      from: input.from,
      to: input.to,
    };
    this.#sink.emit(event);
  }

  /** 模型提案：只记成败与错误码，Prompt 与输出正文不进事件。 */
  proposalRun(input: { principal: Principal; kind: "memory" | "skill"; ok: boolean; errorCode?: string }): void {
    const event: AuditProposalRunEvent = {
      schemaVersion: EVENT_SCHEMA_VERSION,
      eventType: "audit.proposal_run",
      timestamp: new Date().toISOString(),
      userId: input.principal.userId,
      kind: input.kind,
      ok: input.ok,
      ...(input.errorCode === undefined ? {} : { errorCode: input.errorCode }),
    };
    this.#sink.emit(event);
  }
}
