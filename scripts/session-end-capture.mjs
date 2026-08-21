#!/usr/bin/env node
/**
 * Claude Code SessionEnd hook：会话结束时把对话摘要自动送入 memory-skills 的 Evidence 层。
 *
 * 治理边界：
 * - Evidence 捕获始终自动；提案（Draft 生成）默认不触发，仅在显式设置
 *   MEMORY_SKILLS_SESSION_PROPOSALS=1 时开启（会产生真实模型费用，刻意 opt-in）；
 * - 自动 Verify 只由服务端用户预配的确定性规则执行（MEMORY_SKILLS_AUTO_VERIFY），
 *   hook 本身没有任何发布决策权；交互审核的每个 y/n 都是人当场键入的显式决定；
 * - Access Key 只从环境变量读取（MEMORY_SKILLS_ACCESS_KEY），不落任何文件；
 * - 任何失败都静默退出（exit 0），绝不干扰宿主会话收尾；整个脚本有 60s
 *   总预算，超时立即收尾（SessionEnd 不应阻塞会话收尾太久）。
 *
 * 挂载方式（项目或用户级 settings.json）：
 * {
 *   "hooks": {
 *     "SessionEnd": [
 *       { "hooks": [ { "type": "command", "command": "node /path/to/memory_skills/scripts/session-end-capture.mjs" } ] }
 *     ]
 *   }
 * }
 *
 * 需要在运行环境中提供：
 * - MEMORY_SKILLS_URL（默认 http://127.0.0.1:8421）
 * - MEMORY_SKILLS_ACCESS_KEY（必填）
 * - MEMORY_SKILLS_USER_ID / _TEAM_ID / _AGENT_ID / _SESSION_ID（可选，默认与 MCP 适配器一致）
 * - MEMORY_SKILLS_SESSION_PROPOSALS=1（可选，开启会话结束自动提案 + 当场快速审核）
 */

import { createHash } from "node:crypto";
import { createInterface } from "node:readline";
import { closeSync, createReadStream, openSync } from "node:fs";

/**
 * 捕获策略（2026-08-21 按用户决策改为全量捕获）：
 * - 不限消息条数、单条消息不截断——取舍交给提取层，钩子层保持完整事实来源
 *   （旧版"前 10 条助手消息 + 每条 800 字"曾把会话结尾的完成摘要整段丢掉）；
 * - 每个角色仅设保底预算：超预算时保留尾部消息（结论与完成摘要几乎总在会话
 *   结尾）并在摘要头注明省略条数，防止异常超长转录刷库；
 * - 摘要按块切分存证（每块 ≤ CHUNK_CHAR_LIMIT）：块大小对齐提案层
 *   "单条证据 2000 字"的喂入预算，保证每块都能完整进入模型。
 */
const PER_ROLE_CHAR_BUDGET = 60_000;
const CHUNK_CHAR_LIMIT = 1_800;
const FETCH_TIMEOUT_MS = 5_000;
/** 提案请求（真实模型调用）的超时：显著长于普通请求。 */
const PROPOSAL_TIMEOUT_MS = 30_000;
/** 脚本总预算：超时强制收尾，不阻塞宿主会话收尾。 */
const TOTAL_BUDGET_MS = 60_000;
/** 交互审核单条等待上限：空闲超时视为跳过，继续下一条。 */
const REVIEW_IDLE_TIMEOUT_MS = 20_000;
/** 交互展示的 Draft 内容截断长度。 */
const REVIEW_CONTENT_CHARS = 200;

const startedAt = Date.now();
const deadline = startedAt + TOTAL_BUDGET_MS;

main().catch((error) => {
  // hook 失败必须静默：只写 stderr 供排查，不影响宿主
  console.error(`[session-end-capture] ${error instanceof Error ? error.message : String(error)}`);
});

async function main() {
  const payload = await readStdinJson();
  if (!payload?.session_id || !payload.transcript_path) {
    console.error("[session-end-capture] 缺少 session_id 或 transcript_path，跳过捕获");
    return;
  }

  const baseUrl = (process.env.MEMORY_SKILLS_URL ?? "http://127.0.0.1:8421").replace(/\/+$/, "");
  const accessKey = process.env.MEMORY_SKILLS_ACCESS_KEY?.trim();
  if (!accessKey) {
    console.error("[session-end-capture] 未设置 MEMORY_SKILLS_ACCESS_KEY，跳过捕获");
    return;
  }
  const scope = {
    userId: process.env.MEMORY_SKILLS_USER_ID?.trim() || "local-admin",
    teamId: process.env.MEMORY_SKILLS_TEAM_ID?.trim() || "local",
    agentId: process.env.MEMORY_SKILLS_AGENT_ID?.trim() || "default",
    ...(process.env.MEMORY_SKILLS_SESSION_ID?.trim() ? { sessionId: process.env.MEMORY_SKILLS_SESSION_ID.trim() } : {}),
  };

  const { userTexts, assistantTexts } = await extractTranscript(payload.transcript_path);
  const sessionId = String(payload.session_id);

  // 每个角色的摘要可能切成多块证据（每块 ≤ CHUNK_CHAR_LIMIT），全部记入 capturedIds
  const capturedIds = [];
  const roles = [
    ["user", "用户消息", userTexts],
    ["assistant", "助手回复", assistantTexts],
  ];
  for (const [role, title, texts] of roles) {
    if (texts.length === 0) continue;
    const baseId = evidenceId(sessionId, role, texts);
    for (const part of chunkDigest(title, texts, baseId)) {
      await captureEvidence({
        id: part.id,
        role,
        content: part.content,
        baseUrl,
        accessKey,
        scope,
        originSessionId: sessionId,
      });
      capturedIds.push(part.id);
    }
  }

  // 会话结束自动提案（显式 opt-in，产生真实模型费用）：
  // 捕获到的证据立即送提案流水线；能被规则自动 Verify 的已在服务端放行，
  // 剩余 Draft 进入"当场快速审核"或提示稍后用 npm run review:drafts
  if (process.env.MEMORY_SKILLS_SESSION_PROPOSALS === "1" && capturedIds.length > 0 && withinBudget()) {
    const drafts = await runProposal({ baseUrl, accessKey, scope, evidenceIds: capturedIds });
    await reviewDraftsInteractively({ baseUrl, accessKey, scope, drafts });
  }
}

function withinBudget() {
  return Date.now() < deadline;
}

/** 从 Claude Code 会话转录 JSONL 中提取用户与助手的文本消息。 */
async function extractTranscript(transcriptPath) {
  const userTexts = [];
  const assistantTexts = [];
  const readline = createInterface({ input: createReadStream(transcriptPath, { encoding: "utf8" }), crlfDelay: Infinity });
  try {
    for await (const line of readline) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let entry;
      try {
        entry = JSON.parse(trimmed);
      } catch {
        continue;
      }
      if (entry.type === "user" && entry.message) {
        const text = plainText(entry.message.content);
        // 跳过工具结果与宿主元数据（如 <command-name>、<local-command-stdout>）
        if (text && !text.startsWith("<")) userTexts.push(text);
      } else if (entry.type === "assistant" && entry.message) {
        const text = plainText(entry.message.content);
        if (text) assistantTexts.push(text);
      }
    }
  } finally {
    readline.close();
  }
  return { userTexts, assistantTexts };
}

/** 触发 memory 提案并返回仍待人工审核的 Draft（规则已放行的不在其中）。 */
async function runProposal({ baseUrl, accessKey, scope, evidenceIds }) {
  try {
    const response = await fetch(`${baseUrl}/v1/proposals/memory/run`, {
      method: "POST",
      headers: { authorization: `Bearer ${accessKey}`, "content-type": "application/json" },
      body: JSON.stringify({ scope, evidenceIds }),
      signal: AbortSignal.timeout(PROPOSAL_TIMEOUT_MS),
    });
    if (!response.ok) {
      console.error(`[session-end-capture] 提案运行失败：HTTP ${response.status}`);
      return [];
    }
    const report = await response.json();
    const autoVerified = new Set(report.autoVerifiedIds ?? []);
    if (autoVerified.size > 0) {
      console.error(`[session-end-capture] ${autoVerified.size} 条 Draft 已按规则自动 Verify`);
    }
    return (report.created ?? []).filter((asset) => !autoVerified.has(asset.id));
  } catch (error) {
    console.error(`[session-end-capture] 提案运行失败：${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}

/**
 * 当场快速审核剩余 Draft：宿主终端存在时逐条 y/n/a/q；
 * 非 TTY 环境（CI/无终端宿主）只提示一行 stderr，交给 npm run review:drafts。
 * stdin 已被 hook payload 占用，交互直接读写 /dev/tty。
 */
async function reviewDraftsInteractively({ baseUrl, accessKey, scope, drafts }) {
  if (drafts.length === 0) return;
  let tty;
  try {
    tty = openSync("/dev/tty", "r+");
  } catch {
    console.error(`[session-end-capture] 本次会话产生 ${drafts.length} 条 Draft 待审，运行 npm run review:drafts 当场审核`);
    return;
  }
  try {
    console.error(`\n[session-end-capture] 本次会话产生 ${drafts.length} 条 Draft 待审（y=通过 n=拒绝 a=全部通过 q=稍后）：`);
    let verifyAll = false;
    let reviewed = 0;
    for (const [index, draft] of drafts.entries()) {
      if (!withinBudget()) {
        console.error(`[session-end-capture] 达到总时间预算，剩余 ${drafts.length - reviewed} 条留待 npm run review:drafts`);
        return;
      }
      const content = draft.content.length > REVIEW_CONTENT_CHARS
        ? `${draft.content.slice(0, REVIEW_CONTENT_CHARS)}…`
        : draft.content;
      console.error(`\n[${index + 1}/${drafts.length}] (${draft.layer}, 置信 ${draft.governance?.confidence ?? "?"}) ${content}`);
      const answer = verifyAll ? "y" : await promptOnTty(tty, "y/n/a/q > ");
      if (answer === "q") {
        console.error(`[session-end-capture] 已退出交互，剩余 Draft 留待 npm run review:drafts`);
        return;
      }
      if (answer === "a") verifyAll = true;
      if (answer === "y" || answer === "a") {
        await transitionMemory({ baseUrl, accessKey, scope, id: draft.id, target: "verified" });
        console.error(`  -> 已 Verify（人工确认）`);
      } else if (answer === "n") {
        await transitionMemory({ baseUrl, accessKey, scope, id: draft.id, target: "rejected" });
        console.error(`  -> 已拒绝`);
      } else {
        console.error(`  -> 已跳过（留待后续审核）`);
      }
      reviewed += 1;
    }
  } finally {
    try { closeSync(tty); } catch { /* 关闭失败无需处理 */ }
  }
}

/** 在 /dev/tty 上读一行输入；空闲超时返回空串（视为跳过）。 */
function promptOnTty(fd, prompt) {
  return new Promise((resolve) => {
    const stream = createInterface({ input: createReadStream("", { fd }), output: process.stderr, crlfDelay: Infinity });
    let settled = false;
    const finish = (answer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stream.close();
      resolve(answer);
    };
    const timer = setTimeout(() => finish(""), REVIEW_IDLE_TIMEOUT_MS);
    stream.setPrompt(prompt);
    stream.prompt();
    stream.on("line", (line) => finish(line.trim().toLowerCase()));
    stream.on("close", () => finish(""));
  });
}

async function transitionMemory({ baseUrl, accessKey, scope, id, target }) {
  try {
    const response = await fetch(`${baseUrl}/v1/memories/${encodeURIComponent(id)}/status`, {
      method: "POST",
      headers: { authorization: `Bearer ${accessKey}`, "content-type": "application/json" },
      body: JSON.stringify({ scope, target }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) {
      console.error(`[session-end-capture] Draft ${id} ${target} 失败：HTTP ${response.status}`);
    }
  } catch (error) {
    console.error(`[session-end-capture] Draft ${id} ${target} 失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

/** 把 message.content（字符串或内容块数组）规约为纯文本。 */
function plainText(content) {
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content
      .filter((block) => block?.type === "text" && typeof block.text === "string")
      .map((block) => block.text.trim())
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

/**
 * 把一个角色的全部消息构建成分块证据：
 * - 全量消息入块；超预算时只保留尾部消息，并在每块头部注明省略条数；
 * - 单条超长消息硬切跨块，保证每块（含块头）不超过 CHUNK_CHAR_LIMIT；
 * - 单块时沿用旧版无后缀 ID（与既有证据幂等兼容），多块加 -p{k}of{n} 后缀。
 */
function chunkDigest(title, texts, baseId) {
  let omitted = 0;
  let selected = texts;
  const totalLength = texts.reduce((sum, text) => sum + text.length + 2, 0);
  if (totalLength > PER_ROLE_CHAR_BUDGET) {
    const kept = [];
    let used = 0;
    for (let i = texts.length - 1; i >= 0; i -= 1) {
      const text = texts[i];
      // 首条必保（哪怕超预算）：块切分兜底，不让任何角色产出空证据
      if (kept.length > 0 && used + text.length + 2 > PER_ROLE_CHAR_BUDGET - 200) break;
      kept.unshift(text);
      used += text.length + 2;
    }
    omitted = texts.length - kept.length;
    selected = kept;
  }

  const bullets = selected.map((text) => `- ${text.replace(/\n+/g, " ").trim()}`);
  const parts = [];
  let current = [];
  let usedChars = 0;
  const flush = () => {
    if (current.length > 0) parts.push(current);
    current = [];
    usedChars = 0;
  };
  for (const bullet of bullets) {
    if (bullet.length > CHUNK_CHAR_LIMIT) {
      flush();
      for (let i = 0; i < bullet.length; i += CHUNK_CHAR_LIMIT) parts.push([bullet.slice(i, i + CHUNK_CHAR_LIMIT)]);
      continue;
    }
    // 每块预留 120 字给块头（标题 + 省略说明）
    if (usedChars + bullet.length + 1 > CHUNK_CHAR_LIMIT - 120) flush();
    current.push(bullet);
    usedChars += bullet.length + 1;
  }
  flush();
  if (parts.length === 0) parts.push([]);

  return parts.map((lines, index) => ({
    id: parts.length === 1 ? baseId : `${baseId}-p${index + 1}of${parts.length}`,
    content: [
      "Claude Code 会话摘要（SessionEnd 自动捕获 · 全量）",
      "",
      `## ${title} · 第 ${index + 1}/${parts.length} 部分${omitted > 0 ? `（开头 ${omitted} 条因超出预算省略）` : ""}`,
      "",
      ...lines,
    ].join("\n"),
  }));
}

function evidenceId(sessionId, role, texts) {
  const digest = createHash("sha256").update(texts.join("\n"), "utf8").digest("hex").slice(0, 12);
  return `claude-session-${sessionId}-${role}-${digest}`;
}

async function captureEvidence({ id, role, content, baseUrl, accessKey, scope, originSessionId }) {
  const response = await fetch(`${baseUrl}/v1/evidence`, {
    method: "POST",
    headers: { authorization: `Bearer ${accessKey}`, "content-type": "application/json" },
    body: JSON.stringify({ id, scope, role, content, originSessionId }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    // 不读响应体进错误消息，保持失败输出简短
    console.error(`[session-end-capture] evidence ${role} 上报失败：HTTP ${response.status}`);
  }
}

function readStdinJson() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => chunks.push(chunk));
    process.stdin.on("end", () => {
      const raw = chunks.join("").trim();
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(new Error(`hook 输入不是合法 JSON：${error instanceof Error ? error.message : String(error)}`));
      }
    });
    process.stdin.on("error", reject);
  });
}
