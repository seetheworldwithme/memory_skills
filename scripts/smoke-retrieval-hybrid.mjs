#!/usr/bin/env node
// 混合检索真实模型冒烟评测（Task 10 启用门槛的测量工具）。
// 安全约束：必须显式设置 MEMORY_SKILLS_SMOKE=1 才会调用真实 Embedding API；
// Embedding 配置来自 MEMORY_SKILLS_EMBEDDING_* 环境变量（复用离线评测夹具，
// 对比词法与混合的逐用例指标）；输出只有指标与计数，不打印资产正文与密钥。

import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ContextService,
  EmbeddingSyncService,
  HybridRetriever,
  MemoryService,
  SkillService,
  SqliteRepository,
  SqliteVectorIndex,
  createEmbeddingProvider,
  describeEmbeddingConfig,
  resolveEmbeddingConfigFromEnv,
} from "../dist/index.js";

const SMOKE_FLAG = "MEMORY_SKILLS_SMOKE";
const SCRIPT_ROOT = dirname(fileURLToPath(import.meta.url));
const FIXTURES = [
  "fixtures/context-recall.zh-CN.jsonl",
  "fixtures/context-recall.en.jsonl",
].map((fixture) => resolve(SCRIPT_ROOT, "../evals", fixture));

async function main() {
  if (process.env[SMOKE_FLAG] !== "1") {
    console.error(`未设置 ${SMOKE_FLAG}=1，跳过真实 Embedding 调用（防止意外费用）。`);
    console.error(`用法：${SMOKE_FLAG}=1 npm run smoke:retrieval-hybrid`);
    process.exit(1);
  }
  const config = resolveEmbeddingConfigFromEnv(process.env);
  if (config.provider === "mock") {
    console.error("MEMORY_SKILLS_EMBEDDING_PROVIDER 为 mock：零向量没有语义信号，本脚本只测真实模型。");
    process.exit(1);
  }
  const rawProvider = createEmbeddingProvider(config);
  console.log("Embedding 配置：", JSON.stringify(describeEmbeddingConfig(config)));

  // 包装一层计数器：统计调用次数与 Token 用量（不改变行为）
  let embedCalls = 0;
  let totalTokens = 0;
  let costUsd = 0;
  const provider = {
    name: rawProvider.name,
    model: rawProvider.model,
    embed: async (request) => {
      const result = await rawProvider.embed(request);
      embedCalls += 1;
      totalTokens += result.usage?.totalTokens ?? 0;
      costUsd += result.usage?.costUsd ?? 0;
      return result;
    },
  };

  const summary = { improved: [], regressed: [], lexical: zeros(), hybrid: zeros(), cases: 0 };
  for (const fixture of FIXTURES) {
    const corpus = parseFixture(readFileSync(fixture, "utf8"));
    const lexicalMetrics = await runCorpus(corpus, "lexical", provider);
    const hybridMetrics = await runCorpus(corpus, "hybrid", provider);
    compare(fixture, corpus, lexicalMetrics, hybridMetrics, summary);
  }

  console.log("\n=== overall（词法 → 混合） ===");
  printAggregates("lexical", summary.lexical, summary.cases);
  printAggregates("hybrid ", summary.hybrid, summary.cases);
  console.log(`\n改善用例 ${summary.improved.length} 个，退化用例 ${summary.regressed.length} 个`);
  for (const line of summary.improved) console.log(`  + ${line}`);
  for (const line of summary.regressed) console.log(`  - ${line}`);
  console.log(`\nEmbedding 调用 ${embedCalls} 次，Token ${totalTokens}，成本 $${costUsd.toFixed(4)}`);
  console.log(summary.regressed.length === 0
    ? `\n冒烟结论：混合检索无退化${summary.improved.length > 0 ? `，且 ${summary.improved.length} 个用例改善。` : "。"}`
    : `\n冒烟结论：存在 ${summary.regressed.length} 个退化用例，切默认前必须先解决。`);
}

/** 简化版夹具解析：首行为语料头，其余每行一个用例（与 evals 解析逻辑一致）。 */
function parseFixture(raw) {
  const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith("//"));
  const header = JSON.parse(lines[0]);
  return { now: header.now, assets: header.assets, cases: lines.slice(1).map((line) => JSON.parse(line)) };
}

function zeros() {
  return { recall: 0, precision: 0, rr: 0, forbidden: 0 };
}

async function runCorpus(corpus, mode, provider) {
  const repository = new SqliteRepository(":memory:");
  const vectorDb = mode === "hybrid" ? new DatabaseSync(":memory:") : undefined;
  try {
    const now = () => new Date(corpus.now);
    const memory = new MemoryService(repository, now);
    const skills = new SkillService(repository, now);
    const scope = { userId: "eval", teamId: "eval", agentId: "eval" };
    seed(corpus, memory, skills, scope);

    let retriever;
    if (mode === "hybrid") {
      // 同步与检索共用一个索引实例：先写入向量，再挂进 HybridRetriever
      const index = new SqliteVectorIndex(provider.model, ":memory:", vectorDb);
      await new EmbeddingSyncService(memory, skills, provider, index).sync({ scope });
      retriever = new HybridRetriever(provider, index);
    }
    const context = new ContextService(memory, skills, undefined, {}, retriever ? { retriever } : {});

    const metrics = new Map();
    for (const evaluationCase of corpus.cases) {
      const response = await context.recall({
        query: evaluationCase.query, scope,
        maxMemoryResults: 20, maxMemoryChars: 50_000, maxSkillResults: 20, maxSkillChars: 50_000,
      });
      const returnedIds = [...response.memories.map((m) => m.id), ...response.skills.map((s) => s.id)];
      metrics.set(evaluationCase.id, scoreCase(evaluationCase, returnedIds));
    }
    return metrics;
  } finally {
    repository.close();
    vectorDb?.close();
  }
}

function seed(corpus, memory, skills, scope) {
  for (const asset of corpus.assets) {
    if (asset.kind === "memory") {
      const evidence = memory.capture({ id: `ev-${asset.id}`, scope, role: "user", content: asset.content });
      const proposed = memory.propose({
        id: asset.id, layer: "l1", scope, content: asset.content,
        confidence: asset.confidence ?? 0.9, reason: `smoke ${asset.id}`, sourceEvidenceIds: [evidence.id],
        ...(asset.validFrom ? { validFrom: asset.validFrom } : {}),
        ...(asset.validUntil ? { validUntil: asset.validUntil } : {}),
      });
      memory.transition(proposed.id, scope, "verified");
    } else {
      const created = skills.create({
        id: asset.id, scope, name: asset.name, description: asset.description,
        content: `---\nname: ${asset.name}\ndescription: ${JSON.stringify(asset.description)}\n---\n\n${asset.skillContent}`,
        sourceEvidenceIds: [],
      });
      skills.transition(created.id, scope, "verified");
    }
  }
}

/** 与 evals/run-context-recall.ts 的 scoreCase 保持同一口径。 */
function scoreCase(evaluationCase, returnedIds) {
  const k = evaluationCase.k ?? 3;
  const topK = returnedIds.slice(0, k);
  const hits = evaluationCase.expectedIds.filter((id) => topK.includes(id)).length;
  const forbiddenHits = topK.filter((id) => evaluationCase.forbiddenIds.includes(id)).length;
  const firstExpectedRank = evaluationCase.expectedIds
    .map((id) => topK.indexOf(id))
    .filter((index) => index >= 0)
    .reduce((best, index) => Math.min(best, index), Number.POSITIVE_INFINITY);
  return {
    recall: evaluationCase.expectedIds.length === 0 ? 1 : hits / evaluationCase.expectedIds.length,
    precision: topK.length === 0 ? 1 : hits / topK.length,
    rr: evaluationCase.expectedIds.length === 0
      ? (topK.length === 0 ? 1 : 0)
      : Number.isFinite(firstExpectedRank) ? 1 / (firstExpectedRank + 1) : 0,
    forbiddenHits,
  };
}

function compare(fixture, corpus, lexicalMetrics, hybridMetrics, summary) {
  const label = fixture.split("/").pop();
  console.log(`\n=== ${label} ===`);
  const lexicalSum = zeros();
  const hybridSum = zeros();
  let cases = 0;
  for (const evaluationCase of corpus.cases) {
    const lexical = lexicalMetrics.get(evaluationCase.id);
    const hybrid = hybridMetrics.get(evaluationCase.id);
    if (!lexical || !hybrid) continue;
    cases += 1;
    for (const key of ["recall", "precision", "rr"]) {
      lexicalSum[key] += lexical[key];
      hybridSum[key] += hybrid[key];
    }
    lexicalSum.forbidden += lexical.forbiddenHits;
    hybridSum.forbidden += hybrid.forbiddenHits;
    const note = evaluationCase.note ?? "";
    if (hybrid.recall > lexical.recall + 1e-9 || hybrid.rr > lexical.rr + 1e-9 || hybrid.forbiddenHits < lexical.forbiddenHits) {
      summary.improved.push(`${evaluationCase.id}（${note}）：recall ${lexical.recall}→${hybrid.recall}，RR ${lexical.rr.toFixed(2)}→${hybrid.rr.toFixed(2)}，禁 hit ${lexical.forbiddenHits}→${hybrid.forbiddenHits}`);
    }
    if (hybrid.recall < lexical.recall - 1e-9 || hybrid.forbiddenHits > lexical.forbiddenHits
      || hybrid.precision < lexical.precision - 1e-9) {
      summary.regressed.push(`${evaluationCase.id}（${note}）：recall ${lexical.recall}→${hybrid.recall}，precision ${lexical.precision.toFixed(2)}→${hybrid.precision.toFixed(2)}，禁 hit ${lexical.forbiddenHits}→${hybrid.forbiddenHits}`);
    }
  }
  printAggregates("lexical", lexicalSum, cases);
  printAggregates("hybrid ", hybridSum, cases);
  for (const key of ["recall", "precision", "rr", "forbidden"]) {
    summary.lexical[key] += lexicalSum[key];
    summary.hybrid[key] += hybridSum[key];
  }
  summary.cases += cases;
}

function printAggregates(label, sum, cases) {
  if (cases === 0) return;
  const avg = (value) => (value / cases).toFixed(4);
  console.log(`${label} Recall@K ${avg(sum.recall)}  Precision@K ${avg(sum.precision)}  MRR ${avg(sum.rr)}  禁止命中总数 ${sum.forbidden}`);
}

main().catch((error) => {
  console.error("冒烟失败：", error instanceof Error ? `${error.name} ${error.message}` : error);
  process.exit(1);
});
