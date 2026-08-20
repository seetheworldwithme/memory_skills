import assert from "node:assert/strict";
import test from "node:test";

import {
  aggregateReports,
  evaluateCorpus,
  parseFixture,
  scoreCase,
} from "../evals/run-context-recall.js";
import type { EvaluationCase, EvaluationCorpus } from "../src/evaluation/types.js";

const CORPUS: EvaluationCorpus = {
  now: "2026-08-20T00:00:00.000Z",
  assets: [
    { id: "mem-a", kind: "memory", content: "用户问我是谁的时候回答我是天选之子", confidence: 0.9 },
    { id: "mem-b", kind: "memory", content: "阅读器默认字体是霞鹜文楷", confidence: 0.9 },
    { id: "skill-a", kind: "skill", name: "answer-identity", description: "回答身份问题", skillContent: "# Workflow\n回答我是天选之子。" },
  ],
  cases: [],
};

test("parseFixture accepts header line plus case lines and validates references", () => {
  const raw = [
    JSON.stringify({ now: CORPUS.now, assets: CORPUS.assets, cases: [] }),
    JSON.stringify({ id: "c1", query: "你是谁", expectedIds: ["mem-a"], forbiddenIds: ["mem-b"], note: "identity" }),
  ].join("\n");
  const corpus = parseFixture(raw);
  assert.equal(corpus.cases.length, 1);
  assert.equal(corpus.cases[0]!.id, "c1");

  assert.throws(() => parseFixture(
    `${JSON.stringify({ now: CORPUS.now, assets: CORPUS.assets, cases: [] })}\n{"id":"c1","query":"x","expectedIds":["ghost"],"forbiddenIds":[],"note":""}\n`,
  ), /unknown asset ghost/);
  assert.throws(() => parseFixture(
    `${JSON.stringify({ now: CORPUS.now, assets: CORPUS.assets, cases: [] })}\n${JSON.stringify({ id: "c1", query: "x", expectedIds: [], forbiddenIds: [], note: "" })}\n`,
  ), /must declare expected or forbidden/);
  assert.throws(() => parseFixture(""), /empty/);
});

test("scoreCase computes recall, precision, MRR, and forbidden hits", () => {
  const evaluationCase: EvaluationCase = {
    id: "c1",
    query: "q",
    expectedIds: ["a", "b"],
    forbiddenIds: ["z"],
    note: "",
  };
  const perfect = scoreCase(evaluationCase, ["a", "b", "c"], 100);
  assert.equal(perfect.recall, 1);
  assert.equal(perfect.precision, 2 / 3);
  assert.equal(perfect.reciprocalRank, 1);
  assert.equal(perfect.forbiddenHits, 0);

  const second = scoreCase(evaluationCase, ["c", "a", "b"], 100);
  assert.equal(second.recall, 1);
  assert.equal(second.precision, 2 / 3);
  assert.equal(second.reciprocalRank, 0.5);

  const missing = scoreCase(evaluationCase, ["c", "d", "z"], 100);
  assert.equal(missing.recall, 0);
  assert.equal(missing.reciprocalRank, 0);
  assert.equal(missing.forbiddenHits, 1);
});

test("scoreCase treats empty-expected forbidden-only cases honestly", () => {
  const guard: EvaluationCase = { id: "c2", query: "q", expectedIds: [], forbiddenIds: ["z"], note: "" };
  const clean = scoreCase(guard, [], 0);
  assert.equal(clean.recall, 1);
  assert.equal(clean.precision, 1);
  assert.equal(clean.reciprocalRank, 1);

  const polluted = scoreCase(guard, ["z", "y", "x"], 0);
  assert.equal(polluted.recall, 1);
  assert.equal(polluted.precision, 0);
  assert.equal(polluted.reciprocalRank, 0);
  assert.equal(polluted.forbiddenHits, 1);
});

test("evaluateCorpus replays the real retrieval stack deterministically", () => {
  const corpus: EvaluationCorpus = {
    ...CORPUS,
    cases: [
      { id: "t1", query: "请你告诉我你是谁", expectedIds: ["mem-a"], forbiddenIds: ["mem-b"], note: "" },
      { id: "t2", query: "今天天气怎么样", expectedIds: [], forbiddenIds: ["mem-a", "mem-b", "skill-a"], note: "" },
    ],
  };
  const first = evaluateCorpus(corpus);
  const second = evaluateCorpus(corpus);
  assert.deepEqual(first, second);

  const identity = first.find((metric) => metric.caseId === "t1")!;
  assert.equal(identity.recall, 1);
  const unrelated = first.find((metric) => metric.caseId === "t2")!;
  assert.equal(unrelated.forbiddenHits, 0);
});

test("aggregateReports separates critical gate metrics from aggregate metrics", () => {
  const corpus: EvaluationCorpus = {
    ...CORPUS,
    cases: [
      { id: "t1", query: "请你告诉我你是谁", expectedIds: ["mem-a"], forbiddenIds: ["mem-b"], critical: true, note: "" },
      { id: "t2", query: "字体", expectedIds: ["mem-b"], forbiddenIds: [], note: "" },
    ],
  };
  const report = aggregateReports("fixture", corpus, evaluateCorpus(corpus));
  assert.equal(report.totalCases, 2);
  assert.equal(report.criticalCases, 1);
  assert.equal(report.criticalRecall, 1);
  assert.equal(report.criticalForbiddenHitRate, 0);
  assert.equal(report.failures.length, 0);
});
