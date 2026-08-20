import { lexicalScore, matchedQueryTerms } from "./text-match.js";
import type { RankOptions, RankResult, RetrievableDocument, Retriever, ScoredCandidate } from "./types.js";

/**
 * 词法 Retriever：把既有 text-match 打分逻辑包装成统一排序接口。
 * 这是默认实现，也是离线评测基线的来源：
 * 分数 = lexicalScore(query, text) * weight（记忆为 confidence，Skill 为 1），
 * 过滤 score > 0、按分数稳定排序（保持文档枚举顺序），与重构前的
 * MemoryService.recallRanked / SkillService.searchRanked 逐位一致。
 */
export class LexicalRetriever implements Retriever {
  readonly strategy = "lexical" as const;

  async rank(
    query: string,
    documents: readonly RetrievableDocument[],
    options: RankOptions,
  ): Promise<RankResult> {
    return { candidates: rankLexical(query, documents, options), vectorDegraded: false };
  }
}

/** 纯函数形式的词法排序，供 HybridRetriever 在向量降级时复用，保证降级结果与词法路径一致。 */
export function rankLexical(
  query: string,
  documents: readonly RetrievableDocument[],
  options: Pick<RankOptions, "limit">,
): ScoredCandidate[] {
  const scored = documents
    .map((document) => ({
      document,
      score: lexicalScore(query, document.text) * document.weight,
    }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .map(({ document, score }) => ({
      id: document.id,
      score,
      strategy: "lexical" as const,
      matchedTerms: matchedQueryTerms(query, document.text),
    }));
  return options.limit === undefined ? scored : scored.slice(0, options.limit);
}
