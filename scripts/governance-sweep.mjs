#!/usr/bin/env node
/**
 * 治理清扫一次性脚本：顺序执行两项批量治理动作并打印转换清单。
 * - POST /v1/governance/retention/deprecate-expired：validUntil 已过的 Verified 记忆降权待复核
 * - POST /v1/governance/drafts/archive-stale：超过 days（默认 7 天）未审的 Draft 归档
 *
 * 服务自身不引入常驻定时器（纯同步组装是既有架构纪律），周期执行交给外部
 * cron 或手动触发，例（每日 03:17）：
 *   17 3 * * * cd /path/to/memory_skills && npm run governance:sweep >> data/governance-sweep.log 2>&1
 * 不配 cron 也完全可以：GovernancePage 有同功能按钮，手动兜底。
 *
 * 环境变量与其它脚本一致：MEMORY_SKILLS_URL / MEMORY_SKILLS_ACCESS_KEY（必填），
 * MEMORY_SKILLS_USER_ID / _TEAM_ID / _AGENT_ID / _SESSION_ID（可选）。
 * 可选 --days=N 覆盖 Draft 归档阈值。
 */

const FETCH_TIMEOUT_MS = 30_000;

const daysArg = process.argv.find((argument) => argument.startsWith("--days="));
const days = daysArg ? Number.parseInt(daysArg.slice("--days=".length), 10) : undefined;
if (days !== undefined && (!Number.isInteger(days) || days <= 0)) {
  console.error("[governance-sweep] --days 必须是正整数");
  process.exit(1);
}

const baseUrl = (process.env.MEMORY_SKILLS_URL ?? "http://127.0.0.1:8421").replace(/\/+$/, "");
const accessKey = process.env.MEMORY_SKILLS_ACCESS_KEY?.trim();
if (!accessKey) {
  console.error("[governance-sweep] 未设置 MEMORY_SKILLS_ACCESS_KEY");
  process.exit(1);
}
const scope = {
  userId: process.env.MEMORY_SKILLS_USER_ID?.trim() || "local-admin",
  teamId: process.env.MEMORY_SKILLS_TEAM_ID?.trim() || "local",
  agentId: process.env.MEMORY_SKILLS_AGENT_ID?.trim() || "default",
  ...(process.env.MEMORY_SKILLS_SESSION_ID?.trim() ? { sessionId: process.env.MEMORY_SKILLS_SESSION_ID.trim() } : {}),
};

main().catch((error) => {
  console.error(`[governance-sweep] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});

async function main() {
  console.log(`[governance-sweep] 作用域 ${scope.userId}/${scope.teamId}/${scope.agentId} · ${new Date().toISOString()}`);

  const expired = await postJson("/v1/governance/retention/deprecate-expired", { scope });
  report("过期 Verified 记忆降权待复核", expired.memories ?? []);

  const archived = await postJson("/v1/governance/drafts/archive-stale", days === undefined ? { scope } : { scope, days });
  report("超期 Draft 归档", [...(archived.memories ?? []), ...(archived.skills ?? [])]);
}

function report(title, transitions) {
  if (!transitions || transitions.length === 0) {
    console.log(`[governance-sweep] ${title}：无`);
    return;
  }
  console.log(`[governance-sweep] ${title}：${transitions.length} 条`);
  for (const item of transitions) {
    console.log(`  ${item.id} ${item.from} -> ${item.to}`);
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
