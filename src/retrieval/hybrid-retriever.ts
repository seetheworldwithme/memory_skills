import { lexicalScore, matchedQueryTerms } from "./text-match.js";
import { rankLexical } from "./lexical-retriever.js";
import type {
  EmbeddingProvider,
  RankOptions,
  RankResult,
  RetrievableDocument,
  Retriever,
  ScoredCandidate,
  VectorIndex,
} from "./types.js";

/** 融合参数：全部为确定性数值，同一输入永远得到同一排序。 */
export interface HybridRetrieverOptions {
  /** 词法通道权重，默认 1，必须为正数。 */
  lexicalWeight?: number;
  /** 向量通道权重，默认 1，必须为正数。 */
  vectorWeight?: number;
  /**
   * 向量通道激活阈值：余弦 >= 该值才参与融合与入选，默认 0.5。
   * 阈值挡住无关资产（含 Mock 零向量），是精确率的主要护栏。
   * 注意阈值与模型强相关：text-embedding-3-small 约 0.6、large 约 0.5
   * 才能零退化（见 docs/retrieval.md 的真实模型评测数据），换模型后
   * 应先用 npm run smoke:retrieval-hybrid 重新扫描。
   */
  minVectorCosine?: number;
  /**
   * 向量索引单次检索的候选上限，默认 50。
   * 必须独立于文档数：索引行可能在治理过滤（归档/越权）后才被剔除，
   * 若上限等于文档数，非治理行会把治理集内的行挤出 Top-N，
   * 破坏"向量只能重排已过滤候选"的治理约束。
   */
  vectorCandidateLimit?: number;
}

/**
 * 混合检索 Retriever：词法与向量双通道召回 + 确定性融合排序。
 *
 * 融合规则（同一输入永远得到同一输出）：
 * - 词法分 = lexicalScore(query, text) * weight（与基线词法路径完全一致）；
 * - 向量分 = max(0, 余弦相似度)；
 * - 通道激活：词法分 > 0 或 余弦 >= minVectorCosine；
 * - 融合分 = 激活通道的加权平均（Σ w·s / Σ w）。
 *   采用"激活通道归一化"而不是固定权重和：向量通道未激活的候选
 *   融合分退化为纯词法分，保证向量不可用时结果与词法路径逐位一致；
 * - 排序：融合分降序 + 稳定排序（保持文档枚举顺序，与基线一致）。
 *
 * 治理约束：向量索引命中的资产必须存在于调用方传入的文档列表
 * （已完成作用域/状态/有效期过滤）才会参与排序，向量通道永远不能
 * 把未通过治理过滤的资产带入结果，只能改变已过滤候选的排序与入选。
 *
 * 可用性约束：查询向量或索引任何一步失败都降级为纯词法排序，
 * 召回读路径绝不因 Embedding 服务故障而失败。
 */
/** 查询向量进程内缓存上限；同一查询在多资产类型（memory/skill）间复用同一向量。 */
const QUERY_VECTOR_CACHE_LIMIT = 256;

export class HybridRetriever implements Retriever {
  readonly strategy = "hybrid" as const;

  private readonly lexicalWeight: number;
  private readonly vectorWeight: number;
  private readonly minVectorCosine: number;
  private readonly vectorCandidateLimit: number;
  /** 查询向量缓存：同一次 recall 会对 memory/skill 各调一次 rank，避免重复嵌入。 */
  private readonly queryVectorCache = new Map<string, number[]>();

  constructor(
    private readonly provider: EmbeddingProvider,
    private readonly index: VectorIndex,
    options: HybridRetrieverOptions = {},
  ) {
    this.lexicalWeight = options.lexicalWeight ?? 1;
    this.vectorWeight = options.vectorWeight ?? 1;
    this.minVectorCosine = options.minVectorCosine ?? 0.5;
    this.vectorCandidateLimit = options.vectorCandidateLimit ?? 50;
    if (!(this.lexicalWeight > 0) || !Number.isFinite(this.lexicalWeight)) {
      throw new Error("lexicalWeight must be a positive finite number");
    }
    if (!(this.vectorWeight > 0) || !Number.isFinite(this.vectorWeight)) {
      throw new Error("vectorWeight must be a positive finite number");
    }
    if (!(this.minVectorCosine >= 0) || this.minVectorCosine > 1 || !Number.isFinite(this.minVectorCosine)) {
      throw new Error("minVectorCosine must be within [0, 1]");
    }
    if (!Number.isInteger(this.vectorCandidateLimit) || this.vectorCandidateLimit <= 0) {
      throw new Error("vectorCandidateLimit must be a positive integer");
    }
  }

  async rank(
    query: string,
    documents: readonly RetrievableDocument[],
    options: RankOptions,
  ): Promise<RankResult> {
    if (documents.length === 0) return { candidates: [], vectorDegraded: false };

    let cosines: Map<string, number> | undefined;
    try {
      const queryVector = await this.embedQuery(query);
      if (!queryVector || queryVector.length === 0) throw new Error("empty query embedding");
      const matches = await this.index.search({
        vector: queryVector,
        scope: options.scope,
        kind: options.kind,
        limit: this.vectorCandidateLimit,
      });
      // 与治理过滤后的文档求交：索引里过期/越权的资产一律不计分
      const known = new Set(documents.map((document) => document.id));
      cosines = new Map(
        matches
          .filter((match) => known.has(match.assetId) && match.cosine >= this.minVectorCosine)
          .map((match) => [match.assetId, match.cosine]),
      );
    } catch {
      // 降级路径：任何向量通道故障都不影响召回可用性，结果与词法路径一致
      return {
        candidates: rankLexical(query, documents, options),
        vectorDegraded: true,
      };
    }

    if (cosines.size === 0) {
      // 向量通道整体未激活（含 Mock 零向量）：结果与词法路径逐位一致
      return {
        candidates: rankLexical(query, documents, options),
        vectorDegraded: false,
      };
    }

    const scored = documents
      .map((document) => {
        const lexical = lexicalScore(query, document.text) * document.weight;
        const cosine = cosines.get(document.id);
        const vectorActive = cosine !== undefined;
        const lexicalActive = lexical > 0;
        if (!lexicalActive && !vectorActive) return undefined;
        const score = lexicalActive && vectorActive
          ? (this.lexicalWeight * lexical + this.vectorWeight * Math.max(0, cosine!)) / (this.lexicalWeight + this.vectorWeight)
          : lexicalActive ? lexical : Math.max(0, cosine!);
        const strategy = lexicalActive && vectorActive ? "hybrid" : vectorActive ? "vector" : "lexical";
        const candidate: ScoredCandidate = {
          id: document.id,
          score,
          strategy,
          matchedTerms: matchedQueryTerms(query, document.text),
        };
        return candidate;
      })
      .filter((candidate): candidate is ScoredCandidate => candidate !== undefined)
      .sort((a, b) => b.score - a.score);

    return {
      candidates: options.limit === undefined ? scored : scored.slice(0, options.limit),
      vectorDegraded: false,
    };
  }

  /**
   * 查询向量带缓存：失败不缓存（下次重试），缓存满时淘汰最早条目。
   * 缓存不影响结果确定性——同一查询永远得到同一向量。
   */
  private async embedQuery(query: string): Promise<number[] | undefined> {
    const cached = this.queryVectorCache.get(query);
    if (cached) return cached;
    const embedded = await this.provider.embed({ texts: [query] });
    const vector = embedded.vectors[0];
    if (vector && vector.length > 0) {
      if (this.queryVectorCache.size >= QUERY_VECTOR_CACHE_LIMIT) {
        const oldest = this.queryVectorCache.keys().next().value;
        if (oldest !== undefined) this.queryVectorCache.delete(oldest);
      }
      this.queryVectorCache.set(query, vector);
    }
    return vector;
  }
}
