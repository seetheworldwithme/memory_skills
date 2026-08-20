import { randomUUID } from "node:crypto";

import { NotFoundError } from "../errors.js";
import type { Scope } from "../governance/types.js";
import type { SqliteRepository } from "../storage/sqlite-repository.js";
import { FEEDBACK_KINDS, type FeedbackAssetKind, type FeedbackKind, type FeedbackRecord } from "./types.js";

const FEEDBACK_ASSET_KINDS: readonly FeedbackAssetKind[] = ["memory", "skill"];

/**
 * 显式反馈服务：采集"有用 / 无关 / 错误 / 过期"四类人工判断，
 * 提交时关联召回 requestId 与资产当前版本。
 * 反馈只落库供离线评测与治理建议，不触发任何资产状态或内容的自动变更。
 */
export class FeedbackService {
  constructor(
    private readonly repository: SqliteRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  submit(input: {
    id?: string;
    assetKind: FeedbackAssetKind;
    assetId: string;
    scope: Scope;
    kind: FeedbackKind;
    requestId?: string;
    comment?: string;
  }): FeedbackRecord {
    requireText(input.assetId, "assetId");
    if (!FEEDBACK_ASSET_KINDS.includes(input.assetKind)) {
      throw new Error(`assetKind must be one of: ${FEEDBACK_ASSET_KINDS.join(", ")}`);
    }
    if (!FEEDBACK_KINDS.includes(input.kind)) {
      throw new Error(`kind must be one of: ${FEEDBACK_KINDS.join(", ")}`);
    }
    if (input.requestId !== undefined) requireText(input.requestId, "requestId");
    if (input.comment !== undefined) requireText(input.comment, "comment");

    const assetVersion = this.resolveAssetVersion(input.assetKind, input.assetId, input.scope);
    const record: FeedbackRecord = {
      id: input.id ?? randomUUID(),
      assetKind: input.assetKind,
      assetId: input.assetId,
      assetVersion,
      kind: input.kind,
      scope: input.scope,
      ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
      ...(input.comment === undefined ? {} : { comment: input.comment }),
      createdAt: this.now().toISOString(),
    };
    return this.repository.insertFeedback(record);
  }

  /** 按作用域列出反馈，时间倒序（最新在前）：供评测取样本与治理建议展示。 */
  list(scope: Scope): FeedbackRecord[] {
    return this.repository.listFeedback(scope);
  }

  /**
   * 解析反馈针对的资产版本：Skill 用版本号，Memory 用 governance.updatedAt。
   * 资产必须存在于该作用域，否则视为未命中（NOT_FOUND），不产生反馈记录。
   */
  private resolveAssetVersion(assetKind: FeedbackAssetKind, assetId: string, scope: Scope): string {
    if (assetKind === "memory") {
      const memory = this.repository.getMemoryScoped(assetId, scope);
      if (!memory) throw new NotFoundError(`memory not found: ${assetId}`);
      return memory.governance.updatedAt;
    }
    const skill = this.repository.getSkill(assetId);
    if (!skill || !sameScope(skill.scope, scope)) throw new NotFoundError(`skill not found: ${assetId}`);
    return String(skill.version);
  }
}

function requireText(value: string, field: string): void {
  if (!value.trim()) throw new Error(`${field} must not be empty`);
}

function sameScope(a: Scope, b: Scope): boolean {
  return a.userId === b.userId
    && a.teamId === b.teamId
    && a.agentId === b.agentId
    && (a.sessionId ?? null) === (b.sessionId ?? null);
}
