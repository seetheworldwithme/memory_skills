/**
 * 确定性离线检索评测：context recall。
 *
 * 加载 JSONL 评测夹具，把每个用例回放到真实 ContextService + SqliteRepository
 * 栈（内存库），输出 Recall@K / Precision@K / MRR / 禁止命中率 / 平均返回字符数。
 *
 * 门禁：
 * - 基线门禁（默认）：词法路径的聚合 Precision@K 与 MRR 不得低于已记录基线
 *   （evals/baselines/context-recall.v0.3.json）；
 * - 硬门禁（--strict，发布阈值）：关键身份/偏好用例 Recall@K 必须为 1 且零禁止命中。
 *
 * 混合检索验证（--hybrid）：用 Mock 零向量 Provider 走完整混合管线
 * （Embedding 同步 → 向量索引 → 融合排序），断言结果与词法路径逐位一致——
 * 证明混合接入不带来回归；语义增益需用真实模型的 smoke 评测衡量。
 *
 * 退出码：门禁内为 0，任何失败为 1。
 * 标志：--save-baseline 重写基线文件；--verbose 打印每个用例的返回 ID；
 * --strict 启用发布硬门禁；--hybrid 附加混合管线一致性验证。
 *
 * pending 样本（fixtures/pending/*.jsonl，反馈回流导出）：只回放展示，
 * 不进 overall 聚合、不触发基线与 strict 门禁；解析失败提示后跳过。
 */

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ContextService } from "../src/context/context-service.js";
import { MemoryService } from "../src/memory/memory-service.js";
import { SkillService } from "../src/skills/skill-service.js";
import { SqliteRepository } from "../src/storage/sqlite-repository.js";
import { HybridRetriever } from "../src/retrieval/hybrid-retriever.js";
import { MockEmbeddingProvider } from "../src/retrieval/mock-embedding-provider.js";
import { SqliteVectorIndex } from "../src/retrieval/vector-index.js";
import { EmbeddingSyncService } from "../src/retrieval/embedding-sync.js";
import type {
  CaseMetrics,
  EvaluationAsset,
  EvaluationCase,
  EvaluationCorpus,
  EvaluationReport,
} from "../src/evaluation/types.js";

const EVAL_ROOT = fileURLToPath(new URL(".", import.meta.url));
const FIXTURES = [
  "fixtures/context-recall.zh-CN.jsonl",
  "fixtures/context-recall.en.jsonl",
] as const;
/**
 * pending 目录：反馈回流导出的待确认样本（scripts/feedback-to-eval.mjs --export）。
 * 只做报告展示，绝不参与基线与 strict 门禁——人工脱敏补全并移入正式 fixture 后
 * 才按正常流程重生成基线。
 */
const PENDING_DIR = resolve(EVAL_ROOT, "fixtures/pending");
const BASELINE_PATH = resolve(EVAL_ROOT, "baselines/context-recall.v0.3.json");
/** 相对退化容差，避免浮点噪声导致 CI 失败。 */
const REGRESSION_TOLERANCE = 1e-9;

interface Baseline {
  precisionAtK: number;
  mrr: number;
}

export function parseFixture(raw: string): EvaluationCorpus {
  const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0 && !line.startsWith("//"));
  if (lines.length === 0) throw new Error("fixture file is empty");
  let corpus: EvaluationCorpus | undefined;
  const cases: EvaluationCase[] = [];
  for (const line of lines) {
    const parsed = JSON.parse(line) as EvaluationCorpus | EvaluationCase;
    if ("now" in parsed && "assets" in parsed) {
      if (corpus) throw new Error("fixture must contain exactly one corpus header line");
      corpus = parsed;
    } else if ("query" in parsed) {
      cases.push(parsed);
    } else {
      throw new Error(`unrecognized fixture line: ${line.slice(0, 60)}`);
    }
  }
  if (!corpus) throw new Error("fixture must start with a corpus header line");
  if (cases.length === 0) throw new Error("fixture contains no evaluation cases");
  const assetIds = new Set(corpus.assets.map((asset) => asset.id));
  for (const evaluationCase of cases) {
    if (evaluationCase.expectedIds.length === 0 && evaluationCase.forbiddenIds.length === 0) {
      throw new Error(`case ${evaluationCase.id} must declare expected or forbidden ids`);
    }
    for (const id of [...evaluationCase.expectedIds, ...evaluationCase.forbiddenIds]) {
      if (!assetIds.has(id)) throw new Error(`case ${evaluationCase.id} references unknown asset ${id}`);
    }
  }
  return { ...corpus, cases };
}

export async function evaluateCorpus(corpus: EvaluationCorpus, verbose = false): Promise<CaseMetrics[]> {
  const repository = new SqliteRepository(":memory:");
  try {
    seedAssets(repository, corpus.now, corpus.assets);
    const context = new ContextService(new MemoryService(repository), new SkillService(repository));
    return await replayCases(context, corpus, verbose);
  } finally {
    repository.close();
  }
}

/**
 * 用 Mock 零向量 Provider 走完整混合管线后回放同一份用例：
 * 向量通道永不激活，结果必须与词法路径逐位一致（混合接入的无回归证明）。
 */
export async function evaluateCorpusHybrid(corpus: EvaluationCorpus, verbose = false): Promise<CaseMetrics[]> {
  const repository = new SqliteRepository(":memory:");
  const vectorDb = new DatabaseSync(":memory:");
  try {
    seedAssets(repository, corpus.now, corpus.assets);
    const memory = new MemoryService(repository);
    const skills = new SkillService(repository);
    const provider = new MockEmbeddingProvider();
    const index = new SqliteVectorIndex(provider.model, ":memory:", vectorDb);
    await new EmbeddingSyncService(memory, skills, provider, index).sync({ scope: evalScope() });
    const context = new ContextService(memory, skills, undefined, {}, {
      retriever: new HybridRetriever(provider, index),
    });
    return await replayCases(context, corpus, verbose);
  } finally {
    repository.close();
    vectorDb.close();
  }
}

function evalScope() {
  return { userId: "eval", teamId: "eval", agentId: "eval" };
}

async function replayCases(context: ContextService, corpus: EvaluationCorpus, verbose: boolean): Promise<CaseMetrics[]> {
  const scope = evalScope();
  return Promise.all(corpus.cases.map(async (evaluationCase) => {
    const response = await context.recall({
      query: evaluationCase.query,
      scope,
      maxMemoryResults: 20,
      maxMemoryChars: 50_000,
      maxSkillResults: 20,
      maxSkillChars: 50_000,
    });
    const returnedIds = [
      ...response.memories.map((memory) => memory.id),
      ...response.skills.map((skill) => skill.id),
    ];
    if (verbose) console.log(`  [${evaluationCase.id}] <- ${JSON.stringify(returnedIds)}`);
    return scoreCase(evaluationCase, returnedIds, response.budget.usedMemoryChars + response.budget.usedSkillChars);
  }));
}

export function scoreCase(evaluationCase: EvaluationCase, returnedIds: string[], returnedChars: number): CaseMetrics {
  const k = evaluationCase.k ?? 3;
  const topK = returnedIds.slice(0, k);
  const expectedHits = evaluationCase.expectedIds.filter((id) => topK.includes(id)).length;
  const forbiddenHits = topK.filter((id) => evaluationCase.forbiddenIds.includes(id)).length;
  const firstExpectedRank = evaluationCase.expectedIds
    .map((id) => topK.indexOf(id))
    .filter((index) => index >= 0)
    .reduce((best, index) => Math.min(best, index), Number.POSITIVE_INFINITY);
  return {
    caseId: evaluationCase.id,
    recall: evaluationCase.expectedIds.length === 0 ? 1 : expectedHits / evaluationCase.expectedIds.length,
    precision: topK.length === 0 ? 1 : expectedHits / topK.length,
    reciprocalRank: evaluationCase.expectedIds.length === 0
      ? (topK.length === 0 ? 1 : 0)
      : Number.isFinite(firstExpectedRank) ? 1 / (firstExpectedRank + 1) : 0,
    forbiddenHits,
    returnedChars,
  };
}

export function aggregateReports(
  fixture: string,
  corpus: EvaluationCorpus,
  metrics: CaseMetrics[],
): EvaluationReport {
  const total = metrics.length;
  const byId = new Map(metrics.map((metric) => [metric.caseId, metric]));
  const critical = corpus.cases.filter((evaluationCase) => evaluationCase.critical);
  const avg = (selector: (metric: CaseMetrics) => number) =>
    total === 0 ? 0 : metrics.reduce((sum, metric) => sum + selector(metric), 0) / total;
  const criticalMetrics = critical
    .map((evaluationCase) => byId.get(evaluationCase.id))
    .filter((metric): metric is CaseMetrics => Boolean(metric));
  const failures: EvaluationReport["failures"] = [];
  for (const metric of metrics) {
    if (metric.recall < 1) failures.push({ caseId: metric.caseId, reason: `recall=${metric.recall}`, metrics: metric });
    if (metric.forbiddenHits > 0) {
      failures.push({ caseId: metric.caseId, reason: `forbiddenHits=${metric.forbiddenHits}`, metrics: metric });
    }
  }
  const criticalAvg = (selector: (metric: CaseMetrics) => number) =>
    criticalMetrics.length === 0 ? 1 : criticalMetrics.reduce((sum, metric) => sum + selector(metric), 0) / criticalMetrics.length;
  return {
    fixture,
    totalCases: total,
    criticalCases: critical.length,
    recallAtK: avg((metric) => metric.recall),
    precisionAtK: avg((metric) => metric.precision),
    mrr: avg((metric) => metric.reciprocalRank),
    forbiddenHitRate: total === 0 ? 0 : metrics.filter((metric) => metric.forbiddenHits > 0).length / total,
    averageReturnedChars: avg((metric) => metric.returnedChars),
    criticalRecall: criticalAvg((metric) => metric.recall),
    criticalForbiddenHitRate: criticalMetrics.length === 0
      ? 0
      : criticalMetrics.filter((metric) => metric.forbiddenHits > 0).length / criticalMetrics.length,
    failures,
  };
}

function seedAssets(repository: SqliteRepository, now: string, assets: EvaluationAsset[]): void {
  const memory = new MemoryService(repository, () => new Date(now));
  const skills = new SkillService(repository, () => new Date(now));
  const scope = evalScope();
  for (const asset of assets) {
    if (asset.kind === "memory") {
      if (!asset.content?.trim()) throw new Error(`memory asset ${asset.id} requires content`);
      const proposed = memory.propose({
        id: asset.id,
        layer: "l1",
        scope,
        content: asset.content,
        confidence: asset.confidence ?? 0.9,
        reason: `eval fixture ${asset.id}`,
        sourceEvidenceIds: [memory.capture({
          id: `ev-${asset.id}`,
          scope,
          role: "user",
          content: asset.content,
        }).id],
        ...(asset.validFrom ? { validFrom: asset.validFrom } : {}),
        ...(asset.validUntil ? { validUntil: asset.validUntil } : {}),
      });
      memory.transition(proposed.id, scope, "verified");
    } else {
      if (!asset.name || !asset.description || !asset.skillContent?.trim()) {
        throw new Error(`skill asset ${asset.id} requires name, description, and skillContent`);
      }
      const created = skills.create({
        id: asset.id,
        scope,
        name: asset.name,
        description: asset.description,
        content: `---\nname: ${asset.name}\ndescription: ${JSON.stringify(asset.description)}\n---\n\n${asset.skillContent}`,
        sourceEvidenceIds: [],
      });
      skills.transition(created.id, scope, "verified");
    }
  }
}

function loadBaseline(): Baseline | undefined {
  try {
    return JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as Baseline;
  } catch {
    return undefined;
  }
}

function average(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** 列出 pending 目录下的 jsonl 样本文件（目录不存在或为空返回空数组）。 */
function listPendingFixtures(): string[] {
  try {
    return readdirSync(PENDING_DIR)
      .filter((name) => name.endsWith(".jsonl"))
      .sort()
      .map((name) => resolve(PENDING_DIR, name));
  } catch {
    return [];
  }
}

function printReport(label: string, report: EvaluationReport): void {
  console.log(`\n=== ${label} ${report.fixture} (${report.totalCases} cases, ${report.criticalCases} critical) ===`);
  console.log(`Recall@K            ${report.recallAtK.toFixed(4)}`);
  console.log(`Precision@K         ${report.precisionAtK.toFixed(4)}`);
  console.log(`MRR                 ${report.mrr.toFixed(4)}`);
  console.log(`Forbidden hit rate  ${report.forbiddenHitRate.toFixed(4)}`);
  console.log(`Avg returned chars  ${report.averageReturnedChars.toFixed(1)}`);
  console.log(`Critical Recall@K   ${report.criticalRecall.toFixed(4)}`);
  console.log(`Critical forbidden  ${report.criticalForbiddenHitRate.toFixed(4)}`);
  if (report.failures.length > 0) {
    console.log(`Failing cases:`);
    for (const failure of report.failures) console.log(`  - ${failure.caseId}: ${failure.reason}`);
  }
}

async function main(): Promise<void> {
  const verbose = process.argv.includes("--verbose");
  const hybrid = process.argv.includes("--hybrid");
  const reports: EvaluationReport[] = [];
  const hybridReports: EvaluationReport[] = [];
  for (const fixture of FIXTURES) {
    const corpus = parseFixture(readFileSync(resolve(EVAL_ROOT, fixture), "utf8"));
    if (verbose) console.log(`\n--- ${fixture} ---`);
    reports.push(aggregateReports(fixture, corpus, await evaluateCorpus(corpus, verbose)));
    if (hybrid) {
      hybridReports.push(aggregateReports(fixture, corpus, await evaluateCorpusHybrid(corpus, verbose)));
    }
  }

  for (const report of reports) printReport("lexical", report);
  if (hybrid) {
    for (const report of hybridReports) printReport("hybrid(mock)", report);
  }

  // pending 样本：只回放展示，不进 overall 聚合、不触发任何门禁
  for (const pendingFixture of listPendingFixtures()) {
    try {
      const corpus = parseFixture(readFileSync(pendingFixture, "utf8"));
      printReport("pending(lex)", aggregateReports(pendingFixture, corpus, await evaluateCorpus(corpus, verbose)));
    } catch (error) {
      // 人工编辑中的 pending 文件不完整属正常状态，提示后跳过，绝不让 CI 因它失败
      console.warn(`\n--- pending fixture skipped: ${pendingFixture} (${error instanceof Error ? error.message : String(error)}) ---`);
    }
  }

  const overall: Baseline & { recallAtK: number; forbiddenHitRate: number; criticalRecall: number; criticalForbiddenHitRate: number } = {
    recallAtK: average(reports.map((report) => report.recallAtK)),
    precisionAtK: average(reports.map((report) => report.precisionAtK)),
    mrr: average(reports.map((report) => report.mrr)),
    forbiddenHitRate: average(reports.map((report) => report.forbiddenHitRate)),
    criticalRecall: average(reports.map((report) => report.criticalRecall)),
    criticalForbiddenHitRate: average(reports.map((report) => report.criticalForbiddenHitRate)),
  };
  const totalCases = reports.reduce((sum, report) => sum + report.totalCases, 0);
  const totalCritical = reports.reduce((sum, report) => sum + report.criticalCases, 0);
  console.log(`\n=== overall (${totalCases} cases, ${totalCritical} critical) ===`);
  console.log(JSON.stringify(overall, null, 2));

  if (process.argv.includes("--save-baseline")) {
    mkdirSync(dirname(BASELINE_PATH), { recursive: true });
    writeFileSync(BASELINE_PATH, `${JSON.stringify({ precisionAtK: overall.precisionAtK, mrr: overall.mrr }, null, 2)}\n`);
    console.log(`\nbaseline saved to ${BASELINE_PATH}`);
  }

  let failed = false;
  const strict = process.argv.includes("--strict");
  if (strict) {
    if (overall.criticalRecall + REGRESSION_TOLERANCE < 1) {
      console.error(`\nFAIL: critical Recall@K ${overall.criticalRecall.toFixed(4)} below hard gate 1`);
      failed = true;
    }
    if (overall.criticalForbiddenHitRate > REGRESSION_TOLERANCE) {
      console.error(`\nFAIL: critical forbidden hit rate ${overall.criticalForbiddenHitRate.toFixed(4)} above hard gate 0`);
      failed = true;
    }
  }
  const baseline = loadBaseline();
  if (baseline) {
    if (overall.precisionAtK + REGRESSION_TOLERANCE < baseline.precisionAtK) {
      console.error(`\nFAIL: Precision@K regressed below baseline (${overall.precisionAtK.toFixed(4)} < ${baseline.precisionAtK.toFixed(4)})`);
      failed = true;
    }
    if (overall.mrr + REGRESSION_TOLERANCE < baseline.mrr) {
      console.error(`\nFAIL: MRR regressed below baseline (${overall.mrr.toFixed(4)} < ${baseline.mrr.toFixed(4)})`);
      failed = true;
    }
  }
  if (hybrid) {
    // 混合管线一致性门禁：Mock 零向量下逐用例失败集合必须与词法路径完全一致
    let consistent = true;
    for (let index = 0; index < reports.length; index += 1) {
      const lexical = reports[index]!;
      const hybridReport = hybridReports[index]!;
      // 一个用例可能有多条失败记录（recall 与 forbiddenHits），
      // 必须按"用例:原因"做多重集合对比，不能按 caseId 去重
      const toKeys = (failures: EvaluationReport["failures"]) =>
        failures.map((failure) => `${failure.caseId}:${failure.reason}`).sort();
      const lexicalKeys = toKeys(lexical.failures);
      const hybridKeys = toKeys(hybridReport.failures);
      if (lexicalKeys.join("\n") !== hybridKeys.join("\n")) {
        console.error(`\nFAIL: hybrid(mock) diverged from lexical in ${hybridReport.fixture}:`);
        console.error(`  lexical: ${lexicalKeys.join(" | ")}`);
        console.error(`  hybrid : ${hybridKeys.join(" | ")}`);
        consistent = false;
        failed = true;
      }
      if (Math.abs(hybridReport.precisionAtK - lexical.precisionAtK) > REGRESSION_TOLERANCE
        || Math.abs(hybridReport.mrr - lexical.mrr) > REGRESSION_TOLERANCE) {
        console.error(`\nFAIL: hybrid(mock) aggregate metrics diverged in ${hybridReport.fixture}`);
        consistent = false;
        failed = true;
      }
    }
    if (consistent) console.log("\nhybrid(mock) pipeline matches lexical results exactly");
  }
  if (failed) process.exit(1);
  console.log("\nPASS: all metrics within gates and baseline");
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  await main();
}
