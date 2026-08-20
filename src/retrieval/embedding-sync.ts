import type { Scope } from "../governance/types.js";
import type { MemoryService } from "../memory/memory-service.js";
import type { SkillService } from "../skills/skill-service.js";
import { contentHash } from "./vector-index.js";
import { memorySearchText, skillSearchText } from "./types.js";
import type { AssetKind, EmbeddingProvider, VectorIndex, VectorIndexEntry } from "./types.js";

/** 同步报告：只携带计数与模型标识，不携带资产正文。 */
export interface EmbeddingSyncReport {
  model: string;
  scope: Scope;
  memories: EmbeddingSyncKindReport;
  skills: EmbeddingSyncKindReport;
}

export interface EmbeddingSyncKindReport {
  /** 作用域内可召回资产数。 */
  scanned: number;
  /** 本次实际嵌入的资产数（新增或内容变更）。 */
  embedded: number;
  /** 指纹未变跳过的资产数。 */
  unchanged: number;
  /** 索引中已不存在对应可召回资产的行数（已清理）。 */
  removed: number;
}

export interface EmbeddingSyncOptions {
  /** 单次批量嵌入上限，默认 16。 */
  batchSize?: number;
}

/**
 * 向量索引同步：把可召回资产（已通过作用域与治理过滤）的最新正文
 * 嵌入并写入向量索引。增量策略：内容指纹未变则跳过，索引中已失效
 * 的行（资产被归档/删除）会被清理。人工触发，读路径永不写入。
 */
export class EmbeddingSyncService {
  private readonly batchSize: number;

  constructor(
    private readonly memory: MemoryService,
    private readonly skills: SkillService,
    private readonly provider: EmbeddingProvider,
    private readonly index: VectorIndex,
    options: EmbeddingSyncOptions = {},
  ) {
    this.batchSize = options.batchSize ?? 16;
    if (!Number.isInteger(this.batchSize) || this.batchSize <= 0) {
      throw new Error("batchSize must be a positive integer");
    }
  }

  async sync(input: { scope: Scope; includeDraft?: boolean }): Promise<EmbeddingSyncReport> {
    const memories = this.memory.listRecallable(input.scope, input.includeDraft);
    const skills = this.skills.listRecallable(input.scope, input.includeDraft);
    const memoryReport = await this.syncKind("memory", input.scope, memories.map((asset) => ({
      id: asset.id,
      text: memorySearchText(asset),
    })));
    const skillReport = await this.syncKind("skill", input.scope, skills.map((skill) => ({
      id: skill.id,
      text: skillSearchText(skill),
    })));
    return { model: this.provider.model, scope: input.scope, memories: memoryReport, skills: skillReport };
  }

  /** 单类型同步：增量嵌入 + 过期行清理，返回计数报告。 */
  private async syncKind(
    kind: AssetKind,
    scope: Scope,
    assets: readonly { id: string; text: string }[],
  ): Promise<EmbeddingSyncKindReport> {
    const fingerprints = await this.index.fingerprints(scope, kind);
    const known = new Map(fingerprints.map((fingerprint) => [fingerprint.assetId, fingerprint.contentHash]));
    const liveIds = new Set(assets.map((asset) => asset.id));
    const staleIds = [...known.keys()].filter((assetId) => !liveIds.has(assetId));
    await this.index.remove(kind, staleIds);

    const pending = assets.filter((asset) => known.get(asset.id) !== contentHash(asset.text));
    for (let start = 0; start < pending.length; start += this.batchSize) {
      const batch = pending.slice(start, start + this.batchSize);
      const embedded = await this.provider.embed({ texts: batch.map((asset) => asset.text) });
      if (embedded.vectors.length !== batch.length) {
        throw new Error("embedding provider returned mismatched vector count");
      }
      const entries: VectorIndexEntry[] = batch.map((asset, index) => ({
        kind,
        assetId: asset.id,
        scope,
        text: asset.text,
        vector: embedded.vectors[index]!,
      }));
      await this.index.upsert(entries);
    }

    return {
      scanned: assets.length,
      embedded: pending.length,
      unchanged: assets.length - pending.length,
      removed: staleIds.length,
    };
  }
}
