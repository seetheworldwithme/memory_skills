import { LexicalRetriever } from "./lexical-retriever.js";
import { HybridRetriever } from "./hybrid-retriever.js";
import { SqliteVectorIndex } from "./vector-index.js";
import {
  createEmbeddingProvider,
  resolveEmbeddingConfigFromEnv,
  type EmbeddingProviderConfig,
} from "./embedding-provider.js";
import type { EmbeddingProvider, Retriever, VectorIndex } from "./types.js";

type Environment = Record<string, string | undefined>;

/** 检索装配结果：retriever 进入 ContextService，embedding 供同步服务使用。 */
export interface RetrievalAssembly {
  retriever: Retriever;
  /** 仅 hybrid 模式存在；lexical 模式为 undefined，同步端点随之返回 503。 */
  embedding?: {
    provider: EmbeddingProvider;
    index: VectorIndex;
    config: EmbeddingProviderConfig;
    minVectorCosine: number;
  };
}

export interface RetrieverEnvOptions {
  /** 向量索引使用的 SQLite 文件路径；通常与主库同文件（WAL 支持并发）。 */
  vectorDatabasePath: string;
  /** 测试注入的网络与时钟依赖。 */
  deps?: { env?: Environment; fetchImpl?: typeof fetch };
}

/**
 * 从环境变量装配检索层：
 * - MEMORY_SKILLS_RETRIEVAL：lexical（默认）/ hybrid；
 * - hybrid 时按 Embedding 配置创建 Provider 与向量索引，
 *   并读取 MEMORY_SKILLS_HYBRID_LEXICAL_WEIGHT / _VECTOR_WEIGHT（默认 1）
 *   与 MEMORY_SKILLS_HYBRID_MIN_COSINE（默认 0.2）。
 * 默认保持词法：只有真实模型评测证明指标显著提升且命中不退化后，
 * 才应该把部署配置切到 hybrid。
 */
export function resolveRetrieverFromEnv(
  environment: Environment = process.env,
  options: RetrieverEnvOptions,
): RetrievalAssembly {
  const mode = environment.MEMORY_SKILLS_RETRIEVAL?.trim().toLowerCase() || "lexical";
  if (mode !== "lexical" && mode !== "hybrid") {
    throw new Error(`MEMORY_SKILLS_RETRIEVAL 必须是 lexical 或 hybrid，收到：${mode}`);
  }
  if (mode === "lexical") return { retriever: new LexicalRetriever() };

  const config = resolveEmbeddingConfigFromEnv(environment);
  const provider = createEmbeddingProvider(config, options.deps ?? {});
  const index = new SqliteVectorIndex(provider.model, options.vectorDatabasePath);

  const lexicalWeight = optionalPositiveNumber(environment.MEMORY_SKILLS_HYBRID_LEXICAL_WEIGHT, "MEMORY_SKILLS_HYBRID_LEXICAL_WEIGHT") ?? 1;
  const vectorWeight = optionalPositiveNumber(environment.MEMORY_SKILLS_HYBRID_VECTOR_WEIGHT, "MEMORY_SKILLS_HYBRID_VECTOR_WEIGHT") ?? 1;
  const minVectorCosine = optionalUnitNumber(environment.MEMORY_SKILLS_HYBRID_MIN_COSINE, "MEMORY_SKILLS_HYBRID_MIN_COSINE") ?? 0.2;

  const retriever = new HybridRetriever(provider, index, { lexicalWeight, vectorWeight, minVectorCosine });
  return { retriever, embedding: { provider, index, config, minVectorCosine } };
}

function optionalPositiveNumber(raw: string | undefined, name: string): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const value = Number(raw.trim());
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} 必须是正数，收到：${raw}`);
  }
  return value;
}

function optionalUnitNumber(raw: string | undefined, name: string): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const value = Number(raw.trim());
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${name} 必须在 [0, 1] 区间内，收到：${raw}`);
  }
  return value;
}
