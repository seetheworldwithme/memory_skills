import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createMemorySkillsServer } from "../src/api/http-server.js";
import { MemoryService } from "../src/memory/memory-service.js";
import { SkillService } from "../src/skills/skill-service.js";
import { SqliteRepository } from "../src/storage/sqlite-repository.js";
import type { Scope } from "../src/governance/types.js";

const scope: Scope = { userId: "reflow-user", teamId: "team-reflow", agentId: "agent-reflow" };

/** 异步执行脚本：必须用异步 execFile——同步版会阻塞父进程事件循环，
 * 子进程请求本测试起的服务端时会被饿死（请求与等待互锁）。 */
const execFileAsync = promisify(execFile);

function seed(repository: SqliteRepository): void {
  const memory = new MemoryService(repository);
  const evidence = memory.capture({
    id: "reflow-ev-1",
    scope,
    role: "user",
    content: "旧的技术栈偏好说明",
  });
  const asset = memory.propose({
    id: "reflow-mem-1",
    layer: "l1",
    scope,
    content: "新项目一律使用 Python 编写的过时说法",
    confidence: 0.9,
    reason: "reflow fixture",
    sourceEvidenceIds: [evidence.id],
  });
  memory.transition(asset.id, scope, "verified");
}

/**
 * 端到端验证反馈回流数据链路：真实召回（落 recall_log）→ 提交带 requestId 的
 * incorrect 反馈 → 子进程跑 scripts/feedback-to-eval.mjs 导出 pending 样本与报告。
 * 脚本未做参数化导出，用子进程 + 临时输出文件覆盖默认路径，避免污染仓库。
 */
test("feedback-to-eval.mjs：导出 pending 样本与采用率报告", async () => {
  const repository = new SqliteRepository(":memory:");
  seed(repository);
  const accessKey = "reflow-test-key";
  const server = createMemorySkillsServer({ repository, accessKey });
  const outputDir = mkdtempSync(join(tmpdir(), "reflow-"));
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${port}`;
    const headers = { authorization: `Bearer ${accessKey}`, "content-type": "application/json" };
    const post = (path: string, body: unknown) => fetch(`${base}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }).then(async (response) => ({ status: response.status, json: await response.json() }));

    // 一次真实召回拿到 requestId（服务端落 recall_log）
    const recall = await post("/v1/context/recall", { query: "新项目用什么技术栈", scope });
    assert.equal(recall.status, 200);
    assert.equal(recall.json.memories.length, 1);
    const requestId = recall.json.requestId as string;

    // 带 requestId 的 incorrect 反馈（可回流）+ 不带 requestId 的（应被跳过计数）
    const feedback = await post("/v1/feedback", {
      assetKind: "memory",
      assetId: "reflow-mem-1",
      scope,
      kind: "incorrect",
      requestId,
      comment: "说法已过时",
    });
    assert.equal(feedback.status, 200);
    const orphan = await post("/v1/feedback", {
      assetKind: "memory",
      assetId: "reflow-mem-1",
      scope,
      kind: "outdated",
    });
    assert.equal(orphan.status, 200);

    const env = {
      ...process.env,
      MEMORY_SKILLS_URL: base,
      MEMORY_SKILLS_ACCESS_KEY: accessKey,
      MEMORY_SKILLS_USER_ID: scope.userId,
      MEMORY_SKILLS_TEAM_ID: scope.teamId,
      MEMORY_SKILLS_AGENT_ID: scope.agentId,
    };
    const outPath = join(outputDir, "pending.jsonl");

    // --export：样本落盘，结构与正式 fixture 同构
    const { stdout: exportStdout } = await execFileAsync(
      process.execPath,
      ["scripts/feedback-to-eval.mjs", "--export", `--out=${outPath}`],
      { env, encoding: "utf8" },
    );
    assert.match(exportStdout, /导出 1 个样本/);
    assert.match(exportStdout, /无关联召回请求 1 条/);

    const lines = readFileSync(outPath, "utf8").trim().split("\n");
    const header = JSON.parse(lines[0]!);
    assert.ok(Array.isArray(header.assets));
    assert.deepEqual(header.assets.map((asset: { id: string }) => asset.id), ["reflow-mem-1"]);
    const sample = JSON.parse(lines[1]!);
    assert.equal(sample.query, "新项目用什么技术栈");
    assert.deepEqual(sample.forbiddenIds, ["reflow-mem-1"]);
    assert.deepEqual(sample.expectedIds, []);
    assert.match(sample.note, /incorrect 反馈/);

    // --report：统计输出覆盖召回总数与反馈分布
    const { stdout: reportStdout } = await execFileAsync(
      process.execPath,
      ["scripts/feedback-to-eval.mjs", "--report"],
      { env, encoding: "utf8" },
    );
    assert.match(reportStdout, /召回总数（recall_log）：1/);
    assert.match(reportStdout, /错误 1 \/ 过期 1/);
    assert.match(reportStdout, /memory:reflow-mem-1 × 2/);
  } finally {
    server.close();
    rmSync(outputDir, { recursive: true, force: true });
  }
});
