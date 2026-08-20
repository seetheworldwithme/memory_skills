import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { LexicalRetriever, rankLexical } from "../src/retrieval/lexical-retriever.js";
import { HybridRetriever } from "../src/retrieval/hybrid-retriever.js";
import { SqliteVectorIndex, cosineSimilarity, contentHash } from "../src/retrieval/vector-index.js";
import { MockEmbeddingProvider } from "../src/retrieval/mock-embedding-provider.js";
import { EmbeddingSyncService } from "../src/retrieval/embedding-sync.js";
import { ContextService } from "../src/context/context-service.js";
import { MemoryService } from "../src/memory/memory-service.js";
import { SkillService } from "../src/skills/skill-service.js";
import { SqliteRepository } from "../src/storage/sqlite-repository.js";
import type { Scope } from "../src/governance/types.js";
import type { EmbeddingProvider, RetrievableDocument } from "../src/retrieval/types.js";

const scope: Scope = { userId: "u1", teamId: "t1", agentId: "a1" };
const otherScope: Scope = { userId: "u2", teamId: "t1", agentId: "a1" };

/** 测试用可控 Embedding Provider：按文本注入预设向量。 */
class FakeEmbeddingProvider implements EmbeddingProvider {
  readonly name = "fake";
  readonly model: string;
  readonly embeddedTexts: string[] = [];
  failNext = false;

  constructor(
    private readonly vectors: Map<string, number[]>,
    model = "fake-embedding",
  ) {
    this.model = model;
  }

  async embed(request: { texts: readonly string[] }) {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("embedding backend unavailable");
    }
    this.embeddedTexts.push(...request.texts);
    return {
      vectors: request.texts.map((text) => this.vectors.get(text) ?? [0, 0, 0, 0]),
      model: this.model,
      latencyMs: 0,
      attempts: 1,
    };
  }
}

function doc(id: string, text: string, weight = 1): RetrievableDocument {
  return { kind: "memory", id, text, weight };
}

function memoryIndex(provider: EmbeddingProvider): SqliteVectorIndex {
  return new SqliteVectorIndex(provider.model, ":memory:", new DatabaseSync(":memory:"));
}

test("LexicalRetriever 按 weight 打分、过滤零分并稳定排序", async () => {
  const retriever = new LexicalRetriever();
  const documents = [
    doc("a", "用户的中文名是徐子跃", 0.5),
    doc("b", "修bug先复现机制再改代码", 0.95),
    doc("c", "今天中午吃了拉面", 0.9),
  ];
  const result = await retriever.rank("怎么修bug", documents, { scope, kind: "memory" });
  assert.equal(result.vectorDegraded, false);
  assert.deepEqual(result.candidates.map((candidate) => candidate.id), ["b"]);
  assert.equal(result.candidates[0]!.strategy, "lexical");
  assert.equal(result.candidates[0]!.score, 0.95);
  assert.ok(result.candidates[0]!.matchedTerms.length > 0);
});

test("rankLexical limit 不传时返回全部命中", () => {
  const documents = [doc("a", "go backend"), doc("b", "go frontend"), doc("c", "rust cli")];
  const all = rankLexical("go", documents, {});
  assert.equal(all.length, 2);
  const limited = rankLexical("go", documents, { limit: 1 });
  assert.deepEqual(limited.map((candidate) => candidate.id), ["a"]);
});

test("HybridRetriever 向量单通道可召回词法零命中资产", async () => {
  const provider = new FakeEmbeddingProvider(new Map([
    ["备注语言", [1, 0, 0, 0]],
    ["代码注释规范", [0.9, 0.1, 0, 0]],
  ]));
  const index = memoryIndex(provider);
  await index.upsert([
    { kind: "memory", assetId: "m1", scope, text: "代码注释规范", vector: [0.9, 0.1, 0, 0] },
  ]);
  const retriever = new HybridRetriever(provider, index);
  const documents = [doc("m1", "代码注释规范"), doc("m2", "无关内容完全不同")];

  const result = await retriever.rank("备注语言", documents, { scope, kind: "memory" });

  assert.equal(result.vectorDegraded, false);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0]!.id, "m1");
  assert.equal(result.candidates[0]!.strategy, "vector");
});

test("HybridRetriever 向量通道未激活时分数与词法路径逐位一致", async () => {
  const provider = new FakeEmbeddingProvider(new Map([
    ["身份问题", [1, 0, 0, 0]],
    ["用户是天选之子", [0, 1, 0, 0]],
  ]));
  const index = memoryIndex(provider);
  await index.upsert([
    { kind: "memory", assetId: "m1", scope, text: "用户是天选之子", vector: [0, 1, 0, 0] },
  ]);
  const retriever = new HybridRetriever(provider, index);
  const documents = [doc("m1", "用户是天选之子", 0.9)];

  // 查询向量与资产向量正交（余弦 0 < 阈值）：只有词法通道生效
  const lexical = await new LexicalRetriever().rank("天选之子是谁", documents, { scope, kind: "memory" });
  const hybrid = await retriever.rank("天选之子是谁", documents, { scope, kind: "memory" });

  assert.deepEqual(hybrid.candidates, lexical.candidates);
});

test("HybridRetriever 双通道命中时按激活通道加权平均融合", async () => {
  const provider = new FakeEmbeddingProvider(new Map([
    ["查询", [1, 0]],
    ["查询命中", [0.5, 0.866]], // 与查询夹角 60°，余弦 0.5
  ]));
  const index = memoryIndex(provider);
  await index.upsert([
    { kind: "memory", assetId: "m1", scope, text: "查询命中", vector: [0.5, 0.866] },
  ]);
  const retriever = new HybridRetriever(provider, index, { lexicalWeight: 1, vectorWeight: 3, minVectorCosine: 0.2 });
  // 词法分 1（"查询" 二字段完全包含于 "查询命中"），余弦按同一公式计算期望值
  const expectedCosine = 0.5 / Math.sqrt(0.25 + 0.866 * 0.866);
  const result = await retriever.rank("查询", [doc("m1", "查询命中")], { scope, kind: "memory" });
  assert.equal(result.candidates[0]!.strategy, "hybrid");
  assert.ok(Math.abs(result.candidates[0]!.score - (1 + 3 * expectedCosine) / 4) < 1e-12);
});

test("HybridRetriever 余弦低于阈值不入选且不稀释词法分", async () => {
  const provider = new FakeEmbeddingProvider(new Map([
    ["q", [1, 0, 0, 0]],
    ["目标", [0.5, 0.866, 0, 0]], // 与查询夹角 60°，余弦 0.5
  ]));
  const index = memoryIndex(provider);
  await index.upsert([{ kind: "memory", assetId: "m1", scope, text: "目标", vector: [0.5, 0.866, 0, 0] }]);
  const retriever = new HybridRetriever(provider, index, { minVectorCosine: 0.9 });
  const result = await retriever.rank("q", [doc("m1", "目标")], { scope, kind: "memory" });
  assert.equal(result.candidates.length, 0);
});

test("HybridRetriever 治理交集：索引命中但不在文档集的资产被忽略", async () => {
  const provider = new FakeEmbeddingProvider(new Map([
    ["q", [1, 0]],
    ["已归档资产", [1, 0]],
    ["在册资产", [1, 0]],
  ]));
  const index = memoryIndex(provider);
  await index.upsert([
    { kind: "memory", assetId: "archived", scope, text: "已归档资产", vector: [1, 0] },
    { kind: "memory", assetId: "live", scope, text: "在册资产", vector: [1, 0] },
  ]);
  const retriever = new HybridRetriever(provider, index);
  // 文档集只包含 live：归档资产的向量命中不得进入结果
  const result = await retriever.rank("q", [doc("live", "在册资产")], { scope, kind: "memory" });
  assert.deepEqual(result.candidates.map((candidate) => candidate.id), ["live"]);
});

test("HybridRetriever 向量通道故障时降级为词法并标记 vectorDegraded", async () => {
  const provider = new FakeEmbeddingProvider(new Map([["我是谁", [1, 0]]]));
  provider.failNext = true;
  const index = memoryIndex(provider);
  const retriever = new HybridRetriever(provider, index);
  const documents = [doc("m1", "用户问我是谁的时候回答天选之子", 0.9)];

  const degraded = await retriever.rank("我是谁", documents, { scope, kind: "memory" });
  const lexical = await new LexicalRetriever().rank("我是谁", documents, { scope, kind: "memory" });

  assert.equal(degraded.vectorDegraded, true);
  assert.equal(lexical.candidates.length, 1);
  assert.deepEqual(degraded.candidates, lexical.candidates);
});

test("SqliteVectorIndex 余弦检索、作用域隔离与模型隔离", async () => {
  const provider = new FakeEmbeddingProvider(new Map(), "model-a");
  const index = new SqliteVectorIndex("model-a", ":memory:", new DatabaseSync(":memory:"));
  await index.upsert([
    { kind: "memory", assetId: "m1", scope, text: "a", vector: [1, 0] },
    { kind: "memory", assetId: "m2", scope, text: "b", vector: [0, 1] },
    { kind: "memory", assetId: "other-scope", scope: otherScope, text: "c", vector: [1, 0] },
    { kind: "skill", assetId: "s1", scope, text: "d", vector: [1, 0] },
  ]);

  const memoryMatches = await index.search({ vector: [1, 0], scope, kind: "memory", limit: 10 });
  // 索引不做阈值过滤（阈值在 HybridRetriever），按余弦降序返回全部行
  assert.deepEqual(memoryMatches.map((match) => match.assetId), ["m1", "m2"]);
  assert.ok(Math.abs(memoryMatches[0]!.cosine - 1) < 1e-9);
  assert.ok(Math.abs(memoryMatches[1]!.cosine - 0) < 1e-9);

  const skillMatches = await index.search({ vector: [1, 0], scope, kind: "skill", limit: 10 });
  assert.deepEqual(skillMatches.map((match) => match.assetId), ["s1"]);

  // 换模型：旧模型的行对新实例不可见
  const indexB = new SqliteVectorIndex("model-b", ":memory:", new DatabaseSync(":memory:"));
  const empty = await indexB.search({ vector: [1, 0], scope, kind: "memory", limit: 10 });
  assert.equal(empty.length, 0);

  await index.remove("memory", ["m1"]);
  const afterRemove = await index.search({ vector: [1, 0], scope, kind: "memory", limit: 10 });
  // 只删除 m1；m2（余弦 0）仍在索引中
  assert.deepEqual(afterRemove.map((match) => match.assetId), ["m2"]);
  void provider;
});

test("cosineSimilarity 处理零向量与非法输入", () => {
  assert.equal(cosineSimilarity([0, 0], [1, 1]), 0);
  assert.ok(Number.isNaN(cosineSimilarity([1], [1, 2])));
  assert.ok(Number.isNaN(cosineSimilarity([Number.NaN, 0], [1, 0])));
  assert.ok(Math.abs(cosineSimilarity([1, 0, 1], [1, 0, 1]) - 1) < 1e-12);
});

test("EmbeddingSyncService 增量同步：指纹未变跳过、过期行清理", async () => {
  const repository = new SqliteRepository(":memory:");
  try {
    const now = () => new Date("2026-08-20T00:00:00.000Z");
    const memory = new MemoryService(repository, now);
    const skills = new SkillService(repository, now);
    const evidence = memory.capture({ id: "ev-1", scope, role: "user", content: "所有代码注释使用中文" });
    const asset = memory.propose({
      id: "m1", layer: "l1", scope, content: "所有代码注释使用中文",
      confidence: 0.9, reason: "test", sourceEvidenceIds: [evidence.id],
    });
    memory.transition(asset.id, scope, "verified");

    const provider = new FakeEmbeddingProvider(new Map([["所有代码注释使用中文", [1, 0]]]));
    const index = memoryIndex(provider);
    const sync = new EmbeddingSyncService(memory, skills, provider, index);

    const first = await sync.sync({ scope });
    assert.equal(first.memories.embedded, 1);
    assert.equal(first.memories.unchanged, 0);

    const second = await sync.sync({ scope });
    assert.equal(second.memories.embedded, 0);
    assert.equal(second.memories.unchanged, 1);

    // 归档后同步应清理索引行
    memory.transition(asset.id, scope, "archived");
    const third = await sync.sync({ scope });
    assert.equal(third.memories.removed, 1);
    assert.equal(third.memories.scanned, 0);

    const fingerprints = await index.fingerprints(scope, "memory");
    assert.equal(fingerprints.length, 0);
  } finally {
    repository.close();
  }
});

test("contentHash 稳定且区分内容", () => {
  assert.equal(contentHash("abc"), contentHash("abc"));
  assert.notEqual(contentHash("abc"), contentHash("abd"));
});

test("MockEmbeddingProvider 返回确定性零向量", async () => {
  const provider = new MockEmbeddingProvider({ dimensions: 4 });
  const first = await provider.embed({ texts: ["你好", "世界"] });
  const second = await provider.embed({ texts: ["你好", "世界"] });
  assert.deepEqual(first, second);
  assert.deepEqual(first.vectors, [[0, 0, 0, 0], [0, 0, 0, 0]]);
  assert.equal(cosineSimilarity(first.vectors[0]!, [1, 1, 1, 1]), 0);
});

test("ContextService 注入 HybridRetriever 后契约携带策略与降级警告", async () => {
  const repository = new SqliteRepository(":memory:");
  try {
    const now = () => new Date("2026-08-20T00:00:00.000Z");
    const memory = new MemoryService(repository, now);
    const skills = new SkillService(repository, now);
    const evidence = memory.capture({ id: "ev-1", scope, role: "user", content: "用户问我是谁的时候回答天选之子" });
    const asset = memory.propose({
      id: "m1", layer: "l1", scope, content: "用户问我是谁的时候回答天选之子",
      confidence: 0.9, reason: "test", sourceEvidenceIds: [evidence.id],
    });
    memory.transition(asset.id, scope, "verified");

    const provider = new FakeEmbeddingProvider(new Map([
      ["我是谁", [1, 0]],
      ["回答天选之子", [1, 0]],
      ["用户问我是谁的时候回答天选之子", [1, 0]],
    ]));
    const index = memoryIndex(provider);
    await new EmbeddingSyncService(memory, skills, provider, index).sync({ scope });
    const context = new ContextService(memory, skills, undefined, {}, {
      retriever: new HybridRetriever(provider, index),
    });

    const response = await context.recall({ query: "我是谁", scope });
    assert.equal(response.memories.length, 1);
    assert.equal(response.memories[0]!.match.strategy, "hybrid");
    assert.ok(response.memories[0]!.match.score > 0);
    assert.deepEqual(response.warnings, []);

    // Provider 故障：换一个未命中查询缓存的查询，召回不失败，降级为词法并返回警告
    provider.failNext = true;
    const degraded = await context.recall({ query: "回答天选之子", scope });
    assert.equal(degraded.memories[0]!.match.strategy, "lexical");
    assert.deepEqual(degraded.warnings.map((warning) => warning.code), ["RETRIEVAL_DEGRADED_LEXICAL"]);
  } finally {
    repository.close();
  }
});
