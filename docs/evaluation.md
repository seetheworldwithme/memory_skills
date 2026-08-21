# Retrieval Evaluation

Offline, deterministic evaluation for context recall quality. The runner
replays fixture cases through the real `ContextService` + `SqliteRepository`
stack (in-memory), so metrics measure production retrieval behavior, not a
simulation of it.

## Commands

```bash
npm run eval:retrieval            # run metrics, fail on baseline regression
npm run eval:retrieval -- --hybrid  # also verify the hybrid pipeline matches lexical bit-for-bit (offline mock)
npm run eval:retrieval:strict     # also enforce the release hard gate (needs real-model hybrid retrieval, see note)
node --import tsx evals/run-context-recall.ts --verbose   # print returned ids per case
node --import tsx evals/run-context-recall.ts --save-baseline  # rewrite baseline
```

Note on `:strict` — the hard gate requires Recall@K = 1 on every critical
case, which depends on semantic (embedding) recall; offline lexical-only runs
score ~0.45 critical recall by design and will always fail it. Run strict only
against a hybrid setup with the real embedding model (e.g. as part of the
pre-release smoke evaluation); CI/release pipelines enforce the deterministic
baseline + hybrid-consistency gates instead.

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

## Feedback reflow（反馈回流）

真实失败样本回流评测集的运营闭环。每次通过 `/v1/context/recall` 的召回都会
在服务端落一行 `recall_log`（requestId → 查询原文 / 命中资产与分数 / 策略 /
耗时；仅存本地 SQLite，不进观测事件与 API 响应之外的任何通道）。Web 资产
详情页或 Agent 提交的 incorrect/outdated 反馈带 requestId 时，即可还原当时
的查询与命中现场。

流程：

1. `npm run feedback:reflow -- --export`：把 incorrect/outdated 反馈（可用
   `--kinds=` 覆盖）join 召回日志，导出为
   `evals/pending/context-recall.feedback-pending.jsonl`——文件结构与正式
   fixture 同构（首行资产池 + 每行一个用例），`expectedIds` 留空待人工补全，
   被反馈资产自动进 `forbiddenIds`；无 requestId 的反馈跳过并计数。
2. 人工审查 pending 文件：脱敏真实对话内容、补全 `expectedIds`
   （incorrect 的正确答案、outdated 的替代资产需要人判断）。
3. 确认后把用例并入正式 fixture（zh-CN / en），按正常流程
   `--save-baseline` 重生成基线，删除 pending 文件。
4. pending 文件在 `npm run eval:retrieval` 中只回放展示
   （`pending(lex)` 报告），不进 overall 聚合、不触发任何门禁；解析失败
   （人工编辑中的半成品）提示后跳过，不会挂 CI。

`npm run feedback:reflow -- --report` 输出采用率报告：召回总数、四类反馈
分布、反馈覆盖率、采用率下界（有 useful 反馈且无 incorrect/irrelevant 反馈
的召回占比，北极星「有效上下文采用率」的下界近似）与失败资产 Top-N。
显式反馈只是抽样，真实采用率介于该下界与 1−失败率之间；Agent 侧采用信号
接入后再收紧口径。

原始数据端点（review 角色可读）：`POST /v1/recall-log/list`（按作用域列
时间倒序）、`POST /v1/recall-log/get`（按 requestId 精确取，作用域来自日志
记录本身）。
