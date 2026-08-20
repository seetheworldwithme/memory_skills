# Retrieval Evaluation

Offline, deterministic evaluation for context recall quality. The runner
replays fixture cases through the real `ContextService` + `SqliteRepository`
stack (in-memory), so metrics measure production retrieval behavior, not a
simulation of it.

## Commands

```bash
npm run eval:retrieval            # run metrics, fail on baseline regression
npm run eval:retrieval:strict     # also enforce the release hard gate
node --import tsx evals/run-context-recall.ts --verbose   # print returned ids per case
node --import tsx evals/run-context-recall.ts --save-baseline  # rewrite baseline
```

## Fixtures

- `evals/fixtures/context-recall.zh-CN.jsonl` — 56 Chinese cases
- `evals/fixtures/context-recall.en.jsonl` — 22 English cases

Each fixture is a JSONL file: the first line is a corpus header
(`now`, `assets`, `cases: []`); every following line is one evaluation case.

```jsonc
// corpus header
{"now": "2026-08-20T00:00:00.000Z", "assets": [ /* … */ ], "cases": []}
// one case
{"id": "zh-001", "query": "请你告诉我你是谁", "expectedIds": ["mem-identity"],
 "forbiddenIds": ["mem-volume-page"], "k": 3, "critical": true, "note": "身份类"}
```

Rules:

- `expectedIds` must appear in top-K; `forbiddenIds` must never appear in top-K.
  A case must declare at least one of the two.
- `k` defaults to 3.
- `critical: true` marks identity/preference cases subject to the release hard
  gate. Mark only samples whose failure is a correctness bug for the product
  (wrong name, wrong identity, expired preference surfacing), not samples the
  current algorithm is known to miss.
- Assets carry `validFrom`/`validUntil` for expired-information cases; the
  corpus `now` is frozen so validity behaves deterministically.
- **Never weaken expectations to make metrics look better.** If a case is
  genuinely miswritten (wrong semantics), fix it and record why in `note`.

Coverage required by the development plan: identity, preferences, project
decisions, workflows, negation ("不要再叫我阿祖了"), expired information
(validUntil in the past), common-word mismatch (公共词误匹配: asking about
calendars in general must not surface the user's calendar app fact), and long
natural sentences.

## Metrics

- `Recall@K` — share of expected ids present in top-K.
- `Precision@K` — expected hits ÷ items actually returned in top-K
  (1 when a case correctly returns nothing).
- `MRR` — reciprocal rank of the first expected id (1 for forbidden-only
  cases returning nothing).
- `Forbidden hit rate` — share of cases with any forbidden id in top-K.
- `Avg returned chars` — average characters returned per case.

## Gates

| Gate | Scope | Threshold | When it fails the run |
| --- | --- | --- | --- |
| Baseline | aggregate Precision@K, MRR | ≥ recorded baseline (±1e-9) | always |
| Hard (release) | critical cases | Recall@K = 1, forbidden hits = 0 | `--strict` only |

The v0.2 baseline was recorded with the current lexical algorithm:
Recall@K 0.60, Precision@K 0.49, MRR 0.47, critical Recall 0.45. The gap to
the hard gate is expected — it is the measured starting point that future
retrieval work (hybrid, reranking) must close. Do not overwrite the baseline
to make a regression disappear; `--save-baseline` is for recording a new
*accepted* level after a deliberate algorithm change.

## Adding cases

Append a line per case to the fixture. Reference asset ids declared in the
header. Run `npm run eval:retrieval` — a new failing case does not fail the
default gate (only baseline metrics and, under `--strict`, critical cases
do), so additions are safe to land before the algorithm catches up; mark a
case `critical` only when its failure blocks release.
