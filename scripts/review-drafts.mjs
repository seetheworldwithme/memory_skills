#!/usr/bin/env node
/**
 * 批量审核 Draft 的终端 CLI：列出当前作用域全部待审 Draft（memory，--skills 含 skill），
 * 逐条展示内容与来源证据原文供对照，y=通过 n=拒绝 a=全部通过 q=退出，结束打印汇总。
 *
 * 治理边界：每个 y/n 都是人在终端键入的显式决定；本命令不做任何自动判定，
 * 状态转换走与 Web 审核同一 API（POST /v1/{memories,skills}/:id/status，review 权限）。
 *
 * 用法：npm run review:drafts [-- --skills]
 * 环境变量与 SessionEnd hook 一致：
 * - MEMORY_SKILLS_URL（默认 http://127.0.0.1:8421）
 * - MEMORY_SKILLS_ACCESS_KEY（必填）
 * - MEMORY_SKILLS_USER_ID / _TEAM_ID / _AGENT_ID / _SESSION_ID（可选）
 */

import { createInterface } from "node:readline";

const FETCH_TIMEOUT_MS = 10_000;
const CONTENT_CHARS = 400;

const includeSkills = process.argv.includes("--skills");

const baseUrl = (process.env.MEMORY_SKILLS_URL ?? "http://127.0.0.1:8421").replace(/\/+$/, "");
const accessKey = process.env.MEMORY_SKILLS_ACCESS_KEY?.trim();
if (!accessKey) {
  console.error("[review-drafts] 未设置 MEMORY_SKILLS_ACCESS_KEY");
  process.exit(1);
}
const scope = {
  userId: process.env.MEMORY_SKILLS_USER_ID?.trim() || "local-admin",
  teamId: process.env.MEMORY_SKILLS_TEAM_ID?.trim() || "local",
  agentId: process.env.MEMORY_SKILLS_AGENT_ID?.trim() || "default",
  ...(process.env.MEMORY_SKILLS_SESSION_ID?.trim() ? { sessionId: process.env.MEMORY_SKILLS_SESSION_ID.trim() } : {}),
};

main().catch((error) => {
  console.error(`[review-drafts] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});

async function main() {
  const memories = (await postJson("/v1/memories/list", { scope })).items
    .filter((item) => item.governance.status === "draft")
    .map((item) => ({
      kind: "memory",
      id: item.id,
      label: `${item.layer} · 置信 ${Math.round((item.governance.confidence ?? 0) * 100)}%`,
      content: item.content,
      evidenceIds: item.sources.map((source) => source.evidenceId),
    }));
  const skills = includeSkills
    ? (await postJson("/v1/skills/list", { scope })).items
      .filter((item) => item.status === "draft")
      .map((item) => ({
        kind: "skill",
        id: item.id,
        label: `${item.name} v${item.version} · ${item.description}`,
        content: item.content,
        evidenceIds: item.sources.map((source) => source.evidenceId),
      }))
    : [];
  const drafts = [...memories, ...skills];

  if (drafts.length === 0) {
    console.log(includeSkills ? "没有待审 Draft（memory 与 skill 均无）。" : "没有待审 Draft（memory）。提示：加 --skills 连 skill 一起审。");
    return;
  }

  console.log(`待审 Draft 共 ${drafts.length} 条${includeSkills ? "" : "（仅 memory，加 --skills 连 skill 一起审）"}：y=通过 n=拒绝 a=全部通过 q=退出\n`);

  const summary = { verified: 0, rejected: 0, skipped: 0 };
  const rl = createInterface({ input: process.stdin, output: process.stdout, crlfDelay: Infinity });
  try {
    let verifyAll = false;
    for (const [index, draft] of drafts.entries()) {
      const content = draft.content.length > CONTENT_CHARS ? `${draft.content.slice(0, CONTENT_CHARS)}…` : draft.content;
      console.log(`── [${index + 1}/${drafts.length}] ${draft.kind} · ${draft.label}`);
      console.log(content);
      await printEvidence(draft.evidenceIds);
      const answer = verifyAll ? "y" : await ask(rl, "y/n/a/q > ");
      if (answer === "q") {
        summary.skipped += drafts.length - index;
        break;
      }
      if (answer === "a") verifyAll = true;
      if (answer === "y" || answer === "a") {
        await transition(draft, "verified");
        summary.verified += 1;
      } else if (answer === "n") {
        await transition(draft, "rejected");
        summary.rejected += 1;
      } else {
        summary.skipped += 1;
      }
    }
  } finally {
    rl.close();
  }

  console.log(`\n汇总：通过 ${summary.verified} · 拒绝 ${summary.rejected} · 留待 ${summary.skipped}`);
}

/** 展示来源证据原文（对照审核的核心依据）：一次批量拉取，逐条截断展示。 */
async function printEvidence(evidenceIds) {
  if (evidenceIds.length === 0) return;
  try {
    const { items } = await postJson("/v1/evidence/get", { scope, ids: evidenceIds });
    for (const item of items) {
      const excerpt = item.content.length > CONTENT_CHARS ? `${item.content.slice(0, CONTENT_CHARS)}…` : item.content;
      console.log(`   来源证据（${item.role}）：${excerpt.replace(/\n+/g, " ⏎ ")}`);
    }
  } catch (error) {
    console.log(`   来源证据拉取失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

function ask(rl, prompt) {
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => resolve(answer.trim().toLowerCase()));
  });
}

async function transition(draft, target) {
  try {
    await postJson(`/v1/${draft.kind === "skill" ? "skills" : "memories"}/${encodeURIComponent(draft.id)}/status`, { scope, target });
  } catch (error) {
    console.log(`   转换失败（${target}）：${error instanceof Error ? error.message : String(error)}`);
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
  if (!response.ok) {
    throw new Error(`POST ${path} -> HTTP ${response.status}：${text.slice(0, 200)}`);
  }
  return JSON.parse(text);
}
