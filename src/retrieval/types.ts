import type { Scope } from "../governance/types.js";
import type { MatchStrategy } from "../context/contract.js";

/** 参与检索的资产类型：记忆与 Skill 走同一套排序接口。 */
export type AssetKind = "memory" | "skill";

/**
 * 待排序文档。
 * 关键约束：作用域、治理状态、有效期过滤由调用方（MemoryService/SkillService）
 * 在构造文档列表时完成，Retriever 只做纯排序，不感知数据库与治理概念，
 * 因此永远不会把未通过治理过滤的资产带入结果。
 */
export interface RetrievableDocument {
  kind: AssetKind;
  id: string;
  /** 参与匹配的文本：记忆为正文，Skill 为名称+描述+正文。 */
  text: string;
  /** 治理权重：记忆为 governance.confidence，Skill 为 1；沿用既有打分语义。 */
  weight: number;
}

/** 排序后的候选：资产引用 + 命中解释，不携带资产正文。 */
export interface ScoredCandidate {
  id: string;
  /** 归一化相关性分数，范围 (0, 1]。 */
  score: number;
  strategy: MatchStrategy;
  /** 查询中实际命中正文的片段（词法解释）；向量命中可能为空。 */
  matchedTerms: string[];
}

export interface RankOptions {
  scope: Scope;
  kind: AssetKind;
  /** 最多返回条数；不传则返回全部命中（沿用 Skill 全量排序语义）。 */
  limit?: number;
}

/** 记忆的检索文本：正文本身。 */
export function memorySearchText(memory: { content: string }): string {
  return memory.content;
}

/** Skill 的检索文本：名称 + 描述 + 当前版本正文，与既有词法检索口径一致。 */
export function skillSearchText(skill: { name: string; description: string; content: string }): string {
  return `${skill.name} ${skill.description} ${skill.content}`;
}

/** 排序结果：候选列表 + 向量通道健康度，供契约层生成降级警告。 */
export interface RankResult {
  candidates: ScoredCandidate[];
  /** 向量通道出错时降级为纯词法排序；词法 Retriever 恒为 false。 */
  vectorDegraded: boolean;
}

/**
 * 供应商与存储无关的排序接口。
 * ContextService 只依赖本接口：词法是默认实现，混合检索通过注入替换，
 * 换厂商 Embedding 或向量数据库都不需要改动 ContextService。
 */
export interface Retriever {
  /** 检索策略标识：lexical / hybrid，进入诊断事件。 */
  readonly strategy: "lexical" | "hybrid";
  rank(query: string, documents: readonly RetrievableDocument[], options: RankOptions): Promise<RankResult>;
}

/** Embedding 请求：只包含文本与取消信号，不携带 Scope 与治理概念。 */
export interface EmbeddingRequest {
  texts: readonly string[];
  signal?: AbortSignal;
}

/** Embedding 调用结果：向量与输入文本按序一一对应。 */
export interface EmbeddingResult {
  /** 已 L2 归一化的向量；Mock 实现可能为零向量（余弦恒为 0）。 */
  vectors: number[][];
  /** 实际使用的模型标识，作为向量索引的版本键。 */
  model: string;
  usage?: { totalTokens?: number; costUsd?: number };
  latencyMs: number;
  /** 含重试的总尝试次数。 */
  attempts: number;
}

/**
 * 供应商无关的 Embedding Provider 接口。
 * 实现约束与 LlmProvider 相同：不持有 Repository 等领域引用，
 * 不泄漏厂商 SDK 类型，错误消息保持稳定模板。
 */
export interface EmbeddingProvider {
  /** Provider 名称，与配置中的 provider 字段对应。 */
  readonly name: string;
  /** 模型名，向量索引按它做版本隔离。 */
  readonly model: string;
  embed(request: EmbeddingRequest): Promise<EmbeddingResult>;
}

/** 向量索引写入条目：作用域 + 资产引用 + 内容指纹 + 向量。 */
export interface VectorIndexEntry {
  kind: AssetKind;
  assetId: string;
  scope: Scope;
  /** 嵌入时的正文；索引只保存其指纹，不保存正文本身。 */
  text: string;
  vector: readonly number[];
}

export interface VectorQuery {
  /** 已归一化的查询向量。 */
  vector: readonly number[];
  scope: Scope;
  kind: AssetKind;
  limit: number;
}

export interface VectorMatch {
  assetId: string;
  /** 余弦相似度，范围 [-1, 1]；零向量参与计算时恒为 0。 */
  cosine: number;
}

/**
 * 向量索引接口：第一版由 SQLite 实现（元数据 + JSON 向量 + JS 余弦），
 * 后续可替换为专门向量库而不影响检索层其它代码。
 * 实现必须在构造时绑定模型名，不同模型的向量互不可见。
 */
export interface VectorIndex {
  /** 本索引绑定的模型名；与写入时的 Embedding 模型一致。 */
  readonly model: string;
  upsert(entries: readonly VectorIndexEntry[]): Promise<void>;
  remove(kind: AssetKind, assetIds: readonly string[]): Promise<void>;
  search(query: VectorQuery): Promise<VectorMatch[]>;
  /** 列出某作用域某类型的向量指纹（不含向量本体），供同步层比对增量。 */
  fingerprints(scope: Scope, kind: AssetKind): Promise<{ assetId: string; contentHash: string }[]>;
}
