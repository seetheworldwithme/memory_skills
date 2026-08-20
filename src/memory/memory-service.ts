import { transitionStatus, validateConfidence, type GovernedStatus } from "../governance/lifecycle.js";
import type { Scope, SourceReference } from "../governance/types.js";
import type { SqliteRepository } from "../storage/sqlite-repository.js";
import type { Evidence, EvidenceRole, MemoryAsset, MemoryLayer, RecalledMemory } from "./types.js";
import { NotFoundError } from "../errors.js";
import { lexicalScore } from "../retrieval/text-match.js";

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

  transition(id: string, scope: Scope, target: GovernedStatus): MemoryAsset {
    const asset = this.repository.getMemoryScoped(id, scope);
    if (!asset) throw new NotFoundError(`memory not found: ${id}`);
    return this.repository.updateMemoryStatus(
      id,
      transitionStatus(asset.governance.status, target),
      this.now().toISOString(),
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
   * Rank matching memories without applying a character budget, so callers such as
   * ContextService can distinguish count truncation from budget truncation.
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
    const now = this.now().toISOString();
    const allowed = input.includeDraft ? new Set(["verified", "draft"]) : new Set(["verified"]);
    return this.repository.listMemory(input.scope)
      .filter((asset) => allowed.has(asset.governance.status))
      .filter((asset) => !asset.governance.validFrom || asset.governance.validFrom <= now)
      .filter((asset) => !asset.governance.validUntil || asset.governance.validUntil >= now)
      .map((asset) => ({ asset, score: lexicalScore(input.query, asset.content) * asset.governance.confidence }))
      .filter(({ score: value }) => value > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, maxResults)
      .map(({ asset, score: value }) => ({ ...asset, score: value, truncated: false }));
  }

  deleteEvidence(id: string, scope: Scope): { evidenceId: string; archivedMemoryIds: string[]; archivedSkillIds: string[] } {
    const affected = this.repository.deleteEvidenceAndArchiveDerived(id, scope, this.now().toISOString());
    return {
      evidenceId: id,
      archivedMemoryIds: affected.memoryIds,
      archivedSkillIds: affected.skillIds,
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
