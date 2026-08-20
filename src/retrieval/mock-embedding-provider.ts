import type { EmbeddingProvider, EmbeddingRequest, EmbeddingResult } from "./types.js";

export interface MockEmbeddingProviderOptions {
  model?: string;
  /** 向量维度，默认 8；Mock 只产生零向量，维度不影响结果。 */
  dimensions?: number;
}

/**
 * 确定性 Mock Embedding Provider：所有文本嵌入为零向量。
 * 设计意图：余弦相似度恒为 0，向量通道在混合检索中永不激活，
 * 因此离线评测可以用它验证"混合管线接入后词法结果逐位不回归"，
 * 同时保证本地开发与 CI 不产生任何网络调用。
 * 语义增益必须用真实 Provider 的 smoke 评测来衡量。
 */
export class MockEmbeddingProvider implements EmbeddingProvider {
  readonly name = "mock";
  readonly model: string;
  private readonly dimensions: number;

  constructor(options: MockEmbeddingProviderOptions = {}) {
    this.model = options.model ?? "mock-embedding";
    this.dimensions = options.dimensions ?? 8;
  }

  async embed(request: EmbeddingRequest): Promise<EmbeddingResult> {
    if (request.texts.length === 0) {
      return { vectors: [], model: this.model, latencyMs: 0, attempts: 1 };
    }
    return {
      vectors: request.texts.map(() => new Array<number>(this.dimensions).fill(0)),
      model: this.model,
      latencyMs: 0,
      attempts: 1,
    };
  }
}
