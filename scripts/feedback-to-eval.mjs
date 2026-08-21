#!/usr/bin/env node
/**
 * 反馈回流脚本：把真实失败样本（incorrect/outdated 反馈）转成待确认的评测用例，
 * 并输出采用率报告（北极星指标的近似口径）。
 *
 * 两个模式：
 *   --export  导出 pending 评测样本到 evals/pending/context-recall.feedback-pending.jsonl
 *             （期望命中留空，由人工补全；合入正式 fixture 前必须人工脱敏审查）
 *   --report  打印采用率与失败资产统计（纯读操作）
 *
 * 可选参数：--kinds=incorrect,outdated（export 生效，默认 incorrect,outdated）
 *           --out=<file>（export 输出路径，默认 evals/pending/context-recall.feedback-pending.jsonl）
 *
 * 数据全部来自受治理 HTTP API（feedback/list、recall-log/list、recall-log/get、
 * memories/get、skills/get），不直接读 SQLite。
 * 环境变量与其它脚本一致：MEMORY_SKILLS_URL / MEMORY_SKILLS_ACCESS_KEY（必填），
 * MEMORY_SKILLS_USER_ID / _TEAM_ID / _AGENT_ID / _SESSION_ID（可选）。
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const FETCH_TIMEOUT_MS = 30_000;
const DEFAULT_OUT = "evals/pending/context-recall.feedback-pending.jsonl";
const FAILURE_TOP_N = 10;

const args = new Set(process.argv.filter((argument) => argument.startsWith("--")));
const kindArg = process.argv.find((argument) => argument.startsWith("--kinds="));
const outArg = process.argv.find((argument) => argument.startsWith("--out="));
const kinds = kindArg ? kindArg.slice("--kinds=".length).split(",").map((kind) => kind.trim()) : ["incorrect", "outdated"];
const outPath = outArg ? outArg.slice("--out=".length) : DEFAULT_OUT;

const baseUrl = (process.env.MEMORY_SKILLS_URL ?? "http://127.0.0.1:8421").replace(/\/+$/, "");
const accessKey = process.env.MEMORY_SKILLS_ACCESS_KEY?.trim();
if (!accessKey) {
  console.error("[feedback-reflow] 未设置 MEMORY_SKILLS_ACCESS_KEY");
  process.exit(1);
}
const scope = {
  userId: process.env.MEMORY_SKILLS_USER_ID?.trim() || "local-admin",
  teamId: process.env.MEMORY_SKILLS_TEAM_ID?.trim() || "local",
  agentId: process.env.MEMORY_SKILLS_AGENT_ID?.trim() || "default",
  ...(process.env.MEMORY_SKILLS_SESSION_ID?.trim() ? { sessionId: process.env.MEMORY_SKILLS_SESSION_ID.trim() } : {}),
};

if (args.has("--export")) {
  await runExport();
} else if (args.has("--report")) {
  await runReport();
} else {
  console.error("[feedback-reflow] 用法：node scripts/feedback-to-eval.mjs --export | --report");
  process.exit(1);
}

/**
 * 导出 pending 样本：一次召回请求只产一个用例（同请求多条反馈合并进 forbiddenIds），
 * 资产池带上该次召回命中的全部资产，方便人工补全 expectedIds。
 */
async function runExport() {
  const feedback = await postJson("/v1/feedback/list", { scope });
  const items = (feedback.items ?? []).filter((item) => kinds.includes(item.kind));

  const byRequest = new Map();
  let noRequestId = 0;
  for (const item of items) {
    if (!item.requestId) {
      noRequestId += 1;
      continue;
    }
    const entry = byRequest.get(item.requestId) ?? { requestId: item.requestId, feedback: [] };
    entry.feedback.push(item);
    byRequest.set(item.requestId, entry);
  }

  const cases = [];
  const pool = new Map();
  let missingLog = 0;
  for (const entry of byRequest.values()) {
    let log;
    try {
      log = await postJson("/v1/recall-log/get", { requestId: entry.requestId });
    } catch {
      // 反馈早于召回日志功能上线，或请求失败：跳过并计数
      missingLog += 1;
      continue;
    }
    // 资产池：该次召回命中的记忆与 Skill（已删除的资产跳过并提示）
    for (const [hits, assetKind] of [[log.memoryHits, "memory"], [log.skillHits, "skill"]]) {
      for (const hit of hits ?? []) {
        if (pool.has(hit.id)) continue;
        const asset = await fetchAsset(hit.id, assetKind);
        if (asset) pool.set(hit.id, asset);
        else console.warn(`[feedback-reflow] 资产已删除，未进样本资产池：${assetKind} ${hit.id}`);
      }
    }
    const kindsLabel = [...new Set(entry.feedback.map((item) => item.kind))].join("/");
    cases.push({
      id: `fb-${entry.requestId.slice(0, 8)}`,
      query: log.query,
      expectedIds: [],
      forbiddenIds: [...new Set(entry.feedback.map((item) => item.assetId))],
      note: `来源：${kindsLabel} 反馈（requestId=${entry.requestId}，${entry.feedback[0].createdAt}）；`
        + "expectedIds 待人工补全；合入正式 fixture 前需脱敏审查",
      critical: false,
    });
  }

  if (cases.length === 0) {
    console.log(`[feedback-reflow] 没有可导出的样本（反馈 ${items.length} 条，无关联召回请求 ${noRequestId} 条，召回日志缺失 ${missingLog} 条）`);
    return;
  }

  // 文件格式与正式 fixture 一致：首行资产池，后续每行一个用例；已存在的导出会被覆盖
  const lines = [
    JSON.stringify({ now: new Date().toISOString(), assets: [...pool.values()], cases: [] }),
    ...cases.map((item) => JSON.stringify(item)),
  ];
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${lines.join("\n")}\n`);
  console.log(`[feedback-reflow] 导出 ${cases.length} 个样本（资产池 ${pool.size} 条）到 ${outPath}`);
  console.log(`[feedback-reflow] 跳过：无关联召回请求 ${noRequestId} 条，召回日志缺失 ${missingLog} 个请求`);
  console.log("[feedback-reflow] 下一步：人工脱敏审查 + 补全 expectedIds，确认后并入正式 fixture 并重生成基线（见 docs/evaluation.md）");
}

/** 采用率报告：召回总量、反馈覆盖、四分类分布与失败资产 Top-N。 */
async function runReport() {
  const feedback = await postJson("/v1/feedback/list", { scope });
  const recallLog = await postJson("/v1/recall-log/list", { scope });
  const feedbackItems = feedback.items ?? [];
  const recalls = recallLog.items ?? [];

  const counts = { useful: 0, irrelevant: 0, incorrect: 0, outdated: 0 };
  for (const item of feedbackItems) counts[item.kind] = (counts[item.kind] ?? 0) + 1;

  const recallIds = new Set(recalls.map((item) => item.requestId));
  const withFeedback = new Set(feedbackItems.filter((item) => item.requestId).map((item) => item.requestId));
  const usefulRequests = new Set(feedbackItems.filter((item) => item.requestId && item.kind === "useful").map((item) => item.requestId));

  console.log(`[feedback-reflow] 作用域 ${scope.userId}/${scope.teamId}/${scope.agentId} · ${new Date().toISOString()}`);
  console.log(`召回总数（recall_log）：${recalls.length}`);
  console.log(`反馈总数：${feedbackItems.length}（有用 ${counts.useful} / 无关 ${counts.irrelevant} / 错误 ${counts.incorrect} / 过期 ${counts.outdated}）`);
  console.log(`关联到召回的反馈请求数：${withFeedback.size}（覆盖率 ${recalls.length === 0 ? "n/a" : `${((withFeedback.size / recalls.length) * 100).toFixed(1)}%`}）`);
  // 北极星（有效上下文采用率）的下界近似：有 useful 反馈且无错误/无关标记的召回占比。
  // 显式反馈只是抽样，真实采用率介于该下界与 1-失败率之间；等 Agent 侧采用信号接入后再收紧口径
  const badRequests = new Set(feedbackItems
    .filter((item) => item.requestId && (item.kind === "incorrect" || item.kind === "irrelevant"))
    .map((item) => item.requestId));
  const adopted = [...usefulRequests].filter((requestId) => !badRequests.has(requestId)).length;
  console.log(`采用率下界（有有用反馈且无失败反馈的召回 / 总召回）：${recalls.length === 0 ? "n/a" : `${((adopted / recalls.length) * 100).toFixed(1)}%`}（${adopted}/${recalls.length}）`);

  const failures = new Map();
  for (const item of feedbackItems) {
    if (item.kind !== "incorrect" && item.kind !== "outdated") continue;
    failures.set(`${item.assetKind}:${item.assetId}`, (failures.get(`${item.assetKind}:${item.assetId}`) ?? 0) + 1);
  }
  const top = [...failures.entries()].sort((a, b) => b[1] - a[1]).slice(0, FAILURE_TOP_N);
  if (top.length > 0) {
    console.log(`失败反馈资产 Top-${top.length}（incorrect/outdated 按资产聚合）：`);
    for (const [asset, count] of top) console.log(`  ${asset} × ${count}`);
  }
}

/** 取资产正文（记忆或 Skill），404 时返回 undefined 由调用方提示。 */
async function fetchAsset(id, assetKind) {
  try {
    if (assetKind === "memory") {
      const memory = await postJson("/v1/memories/get", { id, scope });
      return {
        id,
        kind: "memory",
        content: memory.content,
        confidence: memory.governance?.confidence ?? 0.8,
      };
    }
    const skill = await postJson("/v1/skills/get", { id, scope });
    return {
      id,
      kind: "skill",
      name: skill.name,
      description: skill.description,
      skillContent: skill.content,
    };
  } catch (error) {
    if (error instanceof HttpError && error.status === 404) return undefined;
    throw error;
  }
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function postJson(path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${accessKey}`, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const text = await response.text();
  if (!response.ok) throw new HttpError(response.status, `POST ${path} -> HTTP ${response.status}：${text.slice(0, 200)}`);
  return JSON.parse(text);
}
