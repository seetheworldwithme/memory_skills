#!/usr/bin/env node
/**
 * Claude Code SessionEnd hook：会话结束时把对话摘要自动送入 memory-skills 的 Evidence 层。
 *
 * 治理边界（有意设计，不随迭代放宽）：
 * - 只自动捕获 Evidence，不触发提案、不产生任何 Draft/Verified 资产；
 * - 提案仍需人工调用 proposals run API，审核仍必须人工 Verify；
 * - Access Key 只从环境变量读取（MEMORY_SKILLS_ACCESS_KEY），不落任何文件；
 * - 任何失败都静默退出（exit 0），绝不干扰宿主会话收尾。
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
 */

import { createHash } from "node:crypto";
import { createInterface } from "node:readline";
import { createReadStream } from "node:fs";

/** 每条消息截断上限与摘要总量上限：Evidence 是索引不是全文归档。 */
const PER_MESSAGE_CHAR_LIMIT = 800;
const TOTAL_CHAR_LIMIT = 16_000;
const MAX_USER_MESSAGES = 30;
const MAX_ASSISTANT_MESSAGES = 10;
const FETCH_TIMEOUT_MS = 5_000;

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
  // 证据 ID 携带内容指纹：同一会话重复触发且摘要未变时幂等，摘要变化时生成新证据而不是冲突报错
  const sessionId = String(payload.session_id);

  if (userTexts.length > 0) {
    await captureEvidence({
      id: evidenceId(sessionId, "user", userTexts),
      role: "user",
      content: formatDigest("用户消息", userTexts),
      baseUrl,
      accessKey,
      scope,
    });
  }
  if (assistantTexts.length > 0) {
    await captureEvidence({
      id: evidenceId(sessionId, "assistant", assistantTexts),
      role: "assistant",
      content: formatDigest("助手回复（节选）", assistantTexts),
      baseUrl,
      accessKey,
      scope,
    });
  }
}

/** 从 Claude Code 会话转录 JSONL 中提取用户与助手的文本消息。 */
async function extractTranscript(transcriptPath) {
  const userTexts = [];
  const assistantTexts = [];
  const readline = createInterface({ input: createReadStream(transcriptPath, { encoding: "utf8" }), crlfDelay: Infinity });
  try {
    for await (const line of readline) {
      if (userTexts.length >= MAX_USER_MESSAGES && assistantTexts.length >= MAX_ASSISTANT_MESSAGES) break;
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

function formatDigest(title, texts) {
  const lines = [`Claude Code 会话摘要（SessionEnd 自动捕获）`, ``, `## ${title}`, ``];
  let used = 0;
  for (const text of texts) {
    const clipped = text.length > PER_MESSAGE_CHAR_LIMIT ? `${text.slice(0, PER_MESSAGE_CHAR_LIMIT)}…` : text;
    if (used + clipped.length > TOTAL_CHAR_LIMIT) break;
    lines.push(`- ${clipped.replace(/\n+/g, " ").trim()}`);
    used += clipped.length;
  }
  return lines.join("\n");
}

function evidenceId(sessionId, role, texts) {
  const digest = createHash("sha256").update(texts.join("\n"), "utf8").digest("hex").slice(0, 12);
  return `claude-session-${sessionId}-${role}-${digest}`;
}

async function captureEvidence({ id, role, content, baseUrl, accessKey, scope }) {
  const response = await fetch(`${baseUrl}/v1/evidence`, {
    method: "POST",
    headers: { authorization: `Bearer ${accessKey}`, "content-type": "application/json" },
    body: JSON.stringify({ id, scope, role, content }),
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
