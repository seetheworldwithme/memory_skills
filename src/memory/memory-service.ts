import { transitionStatus, validateConfidence, type GovernedStatus } from "../governance/lifecycle.js";
import type { Scope, SourceReference } from "../governance/types.js";
import type { SqliteRepository } from "../storage/sqlite-repository.js";
import type { Evidence, EvidenceRole, MemoryAsset, MemoryLayer, RecalledMemory } from "./types.js";
import { NotFoundError } from "../errors.js";
import { lexicalScore, matchedQueryTerms } from "../retrieval/text-match.js";
import type { MatchMetadata } from "../context/contract.js";

export class MemoryService {
  constructor(
    private readonly repository: SqliteRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  capture(input: {
    id: string;
    scope: Scope;
    role: EvidenceRole;
    content: string;
    capturedAt?: string;
    originSessionId?: string;
  }): Evidence {
    requireText(input.id, "id");
    requireText(input.content, "content");
    return this.repository.captureEvidence({
      ...input,
      capturedAt: input.capturedAt ?? this.now().toISOString(),
    });
  }

  propose(input: {
    id: string;
    layer: MemoryLayer;
    scope: Scope;
    content: string;
    confidence: number;
    reason: string;
    sourceEvidenceIds: string[];
    sensitivity?: "normal" | "sensitive" | "restricted";
    validFrom?: string;
    validUntil?: string;
  }): MemoryAsset {
    requireText(input.id, "id");
    requireText(input.content, "content");
    requireText(input.reason, "reason");
    if (input.sourceEvidenceIds.length === 0) throw new Error("memory requires at least one source evidence");
    const now = this.now().toISOString();
    const sources: SourceReference[] = input.sourceEvidenceIds.map((evidenceId) => {
      const evidence = this.repository.getEvidence(evidenceId);
      if (!evidence) throw new Error(`source evidence not found: ${evidenceId}`);
      if (!sameScope(evidence.scope, input.scope)) throw new Error(`source evidence scope mismatch: ${evidenceId}`);
      return { evidenceId, capturedAt: evidence.capturedAt };
    });
    return this.repository.insertMemory({
      id: input.id,
      layer: input.layer,
      scope: input.scope,
      content: input.content,
      governance: {
        status: "draft",
        confidence: validateConfidence(input.confidence),
        createdReason: input.reason,
        createdAt: now,
        updatedAt: now,
        sensitivity: input.sensitivity ?? "normal",
        ...(input.validFrom ? { validFrom: input.validFrom } : {}),
        ...(input.validUntil ? { validUntil: input.validUntil } : {}),
      },
      sources,
    });
  }

  get(id: string, scope: Scope): MemoryAsset | undefined {
    return this.repository.getMemoryScoped(id, scope);
  }

  list(scope: Scope): MemoryAsset[] {
    return this.repository.listMemory(scope);
  }

  transition(
    id: string,
    scope: Scope,
    target: GovernedStatus,
    options?: { verifiedBy?: "auto" | "manual" },
  ): MemoryAsset {
    const asset = this.repository.getMemoryScoped(id, scope);
    if (!asset) throw new NotFoundError(`memory not found: ${id}`);
    return this.repository.updateMemoryStatus(
      id,
      transitionStatus(asset.governance.status, target),
      this.now().toISOString(),
      options,
    );
  }

  recall(input: {
    query: string;
    scope: Scope;
    includeDraft?: boolean;
    maxResults?: number;
    maxTotalChars?: number;
  }): RecalledMemory[] {
    requireText(input.query, "query");
    const maxResults = input.maxResults ?? 5;
    const maxTotalChars = input.maxTotalChars ?? 4_000;
    if (!Number.isInteger(maxResults) || maxResults <= 0) throw new Error("maxResults must be a positive integer");
    if (!Number.isInteger(maxTotalChars) || maxTotalChars <= 0) throw new Error("maxTotalChars must be a positive integer");
    let remaining = maxTotalChars;
    const output: RecalledMemory[] = [];
    for (const ranked of this.recallRanked({ ...input, maxResults, maxTotalChars })) {
      if (remaining <= 0) break;
      const content = ranked.content.length > remaining ? ranked.content.slice(0, remaining) : ranked.content;
      output.push({ ...ranked, content, truncated: content.length < ranked.content.length });
      remaining -= content.length;
    }
    return output;
  }

  /**
   * 带相关性排序的召回（不应用字符预算），让 ContextService 这类调用方
   * 能区分"按条数丢弃"和"按字符预算截断"。
   */
  recallRanked(input: {
    query: string;
    scope: Scope;
    includeDraft?: boolean;
    maxResults?: number;
    maxTotalChars?: number;
  }): RecalledMemory[] {
    requireText(input.query, "query");
    const maxResults = input.maxResults ?? 5;
    if (!Number.isInteger(maxResults) || maxResults <= 0) throw new Error("maxResults must be a positive integer");
    return this.rankLexically(this.listRecallable(input.scope, input.includeDraft), input.query)
      .slice(0, maxResults);
  }

  /**
   * 作用域与治理过滤后的可召回资产（不打词法分、不截断）：
   * 检索层的统一候选来源，保证任何排序策略都建立在同一治理边界之上。
   */
  listRecallable(scope: Scope, includeDraft = false): MemoryAsset[] {
    const now = this.now().toISOString();
    const allowed = includeDraft ? new Set(["verified", "draft"]) : new Set(["verified"]);
    return this.repository.listMemory(scope)
      .filter((asset) => allowed.has(asset.governance.status))
      .filter((asset) => !asset.governance.validFrom || asset.governance.validFrom <= now)
      .filter((asset) => !asset.governance.validUntil || asset.governance.validUntil >= now);
  }

  /**
   * 词法打分排序：分数 = lexicalScore * confidence，过滤零分，保持过滤后的枚举顺序。
   * 每条命中附带 match 元数据（策略/四舍五入分数/命中片段），与上下文契约的
   * toMatchMetadata 同构——MCP recall_memory 的输出 Schema 要求该字段。
   */
  private rankLexically(assets: MemoryAsset[], query: string): RecalledMemory[] {
    return assets
      .map((asset) => ({ asset, score: lexicalScore(query, asset.content) * asset.governance.confidence }))
      .filter(({ score: value }) => value > 0)
      .sort((a, b) => b.score - a.score)
      .map(({ asset, score: value }) => ({
        ...asset,
        score: value,
        truncated: false,
        match: {
          strategy: "lexical",
          score: Number(value.toFixed(4)),
          matchedTerms: matchedQueryTerms(query, asset.content),
        } satisfies MatchMetadata,
      }));
  }

  /**
   * 删除证据并传播：Verified 派生资产标记为待复核（Deprecated，可恢复），
   * 其余状态保持不变。返回每个受影响资产的转换明细，供调用方展示。
   */
  deleteEvidence(id: string, scope: Scope): {
    evidenceId: string;
    memories: Array<{ id: string; from: GovernedStatus; to: GovernedStatus }>;
    skills: Array<{ id: string; from: GovernedStatus; to: GovernedStatus }>;
  } {
    return {
      evidenceId: id,
      ...this.repository.deleteEvidenceAndPropagate(id, scope, this.now().toISOString()),
    };
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
