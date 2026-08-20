/**
 * Deterministic offline retrieval evaluation for context recall.
 *
 * Loads JSONL fixture corpora, replays every case through the real
 * ContextService + SqliteRepository stack (in-memory), and prints
 * Recall@K / Precision@K / MRR / forbidden-hit rate / average returned chars.
 *
 * Gates:
 * - Baseline gate (default): aggregate Precision@K and MRR must not regress
 *   below the recorded baseline (evals/baselines/context-recall.v0.2.json).
 * - Hard gate (--strict, release threshold): critical identity/preference
 *   cases must reach Recall@K = 1 with zero forbidden hits.
 *
 * Exit codes: 0 within gates, 1 on any failure.
 * Flags: --save-baseline rewrites the baseline file, --verbose prints
 * returned ids per case, --strict enables the release hard gate.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ContextService } from "../src/context/context-service.js";
import { MemoryService } from "../src/memory/memory-service.js";
import { SkillService } from "../src/skills/skill-service.js";
import { SqliteRepository } from "../src/storage/sqlite-repository.js";
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
const BASELINE_PATH = resolve(EVAL_ROOT, "baselines/context-recall.v0.2.json");
/** Relative regression tolerance so float noise doesn't fail CI. */
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

export function evaluateCorpus(corpus: EvaluationCorpus, verbose = false): CaseMetrics[] {
  const repository = new SqliteRepository(":memory:");
  try {
    seedAssets(repository, corpus.now, corpus.assets);
    const context = new ContextService(new MemoryService(repository), new SkillService(repository));
    const scope = { userId: "eval", teamId: "eval", agentId: "eval" };
    return corpus.cases.map((evaluationCase) => {
      const response = context.recall({
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
    });
  } finally {
    repository.close();
  }
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
  const scope = { userId: "eval", teamId: "eval", agentId: "eval" };
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

function main(): void {
  const verbose = process.argv.includes("--verbose");
  const reports: EvaluationReport[] = [];
  for (const fixture of FIXTURES) {
    const corpus = parseFixture(readFileSync(resolve(EVAL_ROOT, fixture), "utf8"));
    if (verbose) console.log(`\n--- ${fixture} ---`);
    reports.push(aggregateReports(fixture, corpus, evaluateCorpus(corpus, verbose)));
  }

  for (const report of reports) {
    console.log(`\n=== ${report.fixture} (${report.totalCases} cases, ${report.criticalCases} critical) ===`);
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
  if (failed) process.exit(1);
  console.log("\nPASS: all metrics within gates and baseline");
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main();
}
