import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";

import { createMemorySkillsServer } from "../src/api/http-server.js";
import { ProposalService } from "../src/extraction/proposal-service.js";
import type { ProposalJobInput } from "../src/extraction/interfaces.js";
import { LlmProviderError } from "../src/errors.js";
import { MemoryService } from "../src/memory/memory-service.js";
import { MockLlmProvider, type MockLlmStep } from "../src/llm/mock-provider.js";
import { SkillService } from "../src/skills/skill-service.js";
import { SqliteRepository } from "../src/storage/sqlite-repository.js";
import type { Scope } from "../src/governance/types.js";

const scope: Scope = { userId: "proposal-user", teamId: "team-p", agentId: "agent-p" };

/** 可复现的固定 ID 序列，保证"固定 Evidence + Mock Provider 结果完全可复现"。 */
function fixedIds(): () => string {
  let counter = 0;
  return () => `fixed-id-${counter += 1}`;
}

function buildService(steps: readonly MockLlmStep[], repository = new SqliteRepository(":memory:")) {
  // 固定时钟：保证"固定 Evidence + Mock Provider 结果完全可复现"连时间戳都一致
  const now = () => new Date("2026-08-20T00:00:00Z");
  const memory = new MemoryService(repository, now);
  const skills = new SkillService(repository, now);
  const provider = new MockLlmProvider({ steps, model: "mock-model" });
  const service = new ProposalService({
    memory,
    skills,
    repository,
    provider,
    generateId: fixedIds(),
    now,
  });
  return { repository, memory, skills, provider, service };
}

function seedEvidence(repository: SqliteRepository, contents: string[]): string[] {
  const memory = new MemoryService(repository, () => new Date("2026-08-20T00:00:00Z"));
  return contents.map((content, index) => memory.capture({
    id: `ev-${index + 1}`,
    scope,
    role: "user",
    content,
  }).id);
}

const input: ProposalJobInput = { scope };

test("记忆提案：模型候选经校验后创建 Draft，证据编号映射为真实来源", async () => {
  const repository = buildRepository();
  const evidenceIds = seedEvidence(repository, [
    "以后所有代码注释都用中文写。",
    "今天天气不错。",
  ]);
  const { service, memory } = buildService([{
    type: "ok",
    data: {
      candidates: [
        { layer: "l1", content: "代码注释统一使用中文", confidence: 0.9, reason: "明确的工作偏好", evidenceRefs: [1] },
        { layer: "l1", content: "今天天气不错", confidence: 0.5, reason: "临时状态", evidenceRefs: [2] },
      ],
    },
  }], repository);

  const report = await service.runMemoryProposal({ scope, evidenceIds });

  assert.equal(report.kind, "memory");
  assert.equal(report.model, "mock-model");
  assert.equal(report.promptVersion, "memory-extraction-v1");
  assert.deepEqual(report.inputEvidenceIds, evidenceIds);
  // 两个候选都通过了服务端硬校验（"是否临时状态"这类语义判断由 Prompt 约束模型）
  assert.equal(report.created.length, 2);
  assert.equal(report.attempts, 1);

  const draft = report.created[0]!;
  assert.equal(draft.content, "代码注释统一使用中文");
  assert.equal(draft.layer, "l1");
  assert.equal(draft.governance.status, "draft");
  assert.equal(draft.governance.confidence, 0.9);
  assert.deepEqual(draft.sources.map((source) => source.evidenceId), [evidenceIds[0]]);

  assert.equal(memory.list(scope).length, 2);
});

function buildRepository(): SqliteRepository {
  return new SqliteRepository(":memory:");
}

test("记忆提案：占位内容、敏感信息、无来源与无效编号的候选被拒绝并给出原因", async () => {
  const repository = buildRepository();
  const evidenceIds = seedEvidence(repository, ["密钥是 sk-abcdefghijklmnopqrst，注意保管。", "证据原文"]);
  const { service, memory } = buildService([{
    type: "ok",
    data: {
      candidates: [
        { layer: "l1", content: "Describe the trigger conditions.", confidence: 0.9, reason: "有理由", evidenceRefs: [1] },
        { layer: "l1", content: "用户的 API 密钥是 sk-abcdefghijklmnopqrst", confidence: 0.9, reason: "有理由", evidenceRefs: [1] },
        { layer: "l1", content: "一条没有来源引用的记忆内容", confidence: 0.9, reason: "有理由", evidenceRefs: [] },
        { layer: "l1", content: "引用了不存在编号的记忆内容", confidence: 0.9, reason: "有理由", evidenceRefs: [99] },
        { layer: "l1", content: "太短", confidence: 0.9, reason: "有理由", evidenceRefs: [1] },
      ],
    },
  }], repository);

  const report = await service.runMemoryProposal({ scope, evidenceIds });

  assert.equal(report.created.length, 0);
  assert.equal(report.rejected.length, 5);
  assert.ok(report.rejected[0]!.reasons.includes("包含占位内容"));
  assert.ok(report.rejected[1]!.reasons.some((reason) => reason.includes("敏感")));
  assert.ok(report.rejected[2]!.reasons.includes("缺少来源证据引用"));
  assert.ok(report.rejected[3]!.reasons.includes("证据引用编号无效"));
  assert.ok(report.rejected[4]!.reasons.includes("内容过于简短"));
  assert.equal(memory.list(scope).length, 0);
});

test("记忆提案：同批重复与库内现存内容重复的候选被拒绝", async () => {
  const repository = buildRepository();
  const evidenceIds = seedEvidence(repository, ["用户偏好中文沟通。"]);
  const { memory } = buildService([], repository);
  // 库内已有一条内容等价（仅空白差异）的 Verified 资产
  const seeded = new MemoryService(repository);
  seeded.propose({
    id: "existing-mem",
    layer: "l1",
    scope,
    content: "用户 偏好 中文沟通", // 归一化后与候选相同
    confidence: 0.9,
    reason: "既有资产",
    sourceEvidenceIds: [evidenceIds[0]!],
  });
  seeded.transition("existing-mem", scope, "verified");

  const { service } = buildService([{
    type: "ok",
    data: {
      candidates: [
        { layer: "l1", content: "用户偏好中文沟通", confidence: 0.8, reason: "重复候选", evidenceRefs: [1] },
        { layer: "l1", content: "用户偏好中文沟通", confidence: 0.7, reason: "同批重复", evidenceRefs: [1] },
      ],
    },
  }], repository);

  const report = await service.runMemoryProposal({ scope, evidenceIds });
  assert.equal(report.created.length, 0);
  assert.equal(report.rejected.length, 2);
  assert.equal(memory.list(scope).length, 1); // 只有库内原有资产
});

test("记忆提案：没有证据时不调用模型，返回空报告", async () => {
  const { service, provider } = buildService([{ type: "ok", data: { candidates: [] } }]);

  const report = await service.runMemoryProposal(input);

  assert.equal(report.created.length, 0);
  assert.equal(report.inputEvidenceIds.length, 0);
  assert.equal(report.model, "");
  assert.equal(provider.receivedRequests.length, 0);
});

test("记忆提案：未指定证据 ID 时默认取该作用域最近一批（时间倒序）", async () => {
  const repository = buildRepository();
  seedEvidence(repository, ["第一条旧证据", "第二条新证据"]);
  const { service, provider } = buildService([{ type: "ok", data: { candidates: [] } }], repository);

  await service.runMemoryProposal({ scope, maxEvidence: 2 });

  assert.equal(provider.receivedRequests.length, 1);
  const userContent = provider.receivedRequests[0]!.userContent;
  // 最新证据在前：编号 1 对应第二条新证据
  assert.ok(userContent.indexOf("第二条新证据") < userContent.indexOf("第一条旧证据"));
});

test("记忆提案：显式指定的证据不存在时报 NOT_FOUND", async () => {
  const { service } = buildService([]);
  await assert.rejects(
    () => service.runMemoryProposal({ scope, evidenceIds: ["missing-ev"] }),
    (error) => error instanceof LlmProviderError === false && (error as { code?: string }).code === "NOT_FOUND",
  );
});

test("记忆提案：模型调用失败时不产生任何 Draft（无半写入）", async () => {
  const repository = buildRepository();
  const evidenceIds = seedEvidence(repository, ["证据原文"]);
  const { service, memory } = buildService([{ type: "invalid-json" }], repository);

  await assert.rejects(
    () => service.runMemoryProposal({ scope, evidenceIds }),
    (error) => error instanceof LlmProviderError && error.code === "LLM_INVALID_RESPONSE",
  );
  assert.equal(memory.list(scope).length, 0);
});

test("Skill 提案：合法 SKILL.md 候选创建 Draft，占位与格式错误被拒绝", async () => {
  const repository = buildRepository();
  const evidenceIds = seedEvidence(repository, [
    "部署前先跑 npm test 和 typecheck，全绿才合并；失败时先修复再重试。",
    "闲聊内容。",
  ]);
  const { skills } = buildService([], repository);

  const goodContent = [
    "---",
    `name: ${JSON.stringify("verify-before-merge")}`,
    `description: ${JSON.stringify("合并前执行完整验证流程")}`,
    "---",
    "",
    "# 合并前验证",
    "",
    "## 何时使用",
    "",
    "准备合并代码变更时使用。",
    "",
    "## 工作流",
    "",
    "1. 运行 npm test；",
    "2. 运行 npm run typecheck；",
    "3. 全部通过后合并。",
    "",
    "## 失败处理",
    "",
    "失败时修复后重新执行全部步骤。",
    "",
    "## 验证方式",
    "",
    "确认两条命令退出码均为 0。",
  ].join("\n");

  const { service } = buildService([{
    type: "ok",
    data: {
      candidates: [
        {
          name: "verify-before-merge",
          description: "合并前执行完整验证流程",
          content: goodContent,
          evidenceRefs: [1],
        },
        {
          name: "placeholder-skill",
          description: "占位 Skill",
          content: "---\nname: placeholder-skill\ndescription: 占位 Skill\n---\n\n# Skill\n\n## 何时使用\n\nDescribe the trigger conditions.\n",
          evidenceRefs: [2],
        },
        {
          name: "Bad_Name",
          description: "命名不合法",
          content: "---\nname: Bad_Name\ndescription: 命名不合法\n---\n\n# Skill\n\n## 工作流\n\n1. 步骤一\n",
          evidenceRefs: [2],
        },
      ],
    },
  }], repository);

  const report = await service.runSkillProposal({ scope, evidenceIds });

  assert.equal(report.created.length, 1);
  assert.equal(report.promptVersion, "skill-extraction-v1");
  const draft = report.created[0]!;
  assert.equal(draft.name, "verify-before-merge");
  assert.equal(draft.status, "draft");
  assert.deepEqual(draft.sources.map((source) => source.evidenceId), [evidenceIds[0]]);

  assert.equal(report.rejected.length, 2);
  assert.ok(report.rejected[0]!.reasons.includes("SKILL.md 包含占位内容"));
  assert.ok(report.rejected[1]!.reasons.includes("name 必须是 kebab-case"));
  assert.equal(skills.list(scope).length, 1);
});

test("Skill 提案：同名 Skill 已存在时该候选转为拒绝，其余候选不受影响", async () => {
  const repository = buildRepository();
  const evidenceIds = seedEvidence(repository, ["证据一", "证据二"]);
  const existing = new SkillService(repository);
  existing.create({
    id: "existing-skill",
    scope,
    name: "duplicate-name",
    description: "已存在的 Skill",
    content: "---\nname: duplicate-name\ndescription: 已存在的 Skill\n---\n\n# Skill\n\n## 工作流\n\n1. 已有步骤\n",
    sourceEvidenceIds: [evidenceIds[0]!],
  });

  const { service, skills } = buildService([{
    type: "ok",
    data: {
      candidates: [
        {
          name: "duplicate-name",
          description: "重名候选",
          content: "---\nname: duplicate-name\ndescription: 重名候选\n---\n\n# Skill\n\n## 工作流\n\n1. 新步骤\n",
          evidenceRefs: [1],
        },
        {
          name: "fresh-name",
          description: "不重名候选",
          content: "---\nname: fresh-name\ndescription: 不重名候选\n---\n\n# Skill\n\n## 工作流\n\n1. 新步骤\n",
          evidenceRefs: [2],
        },
      ],
    },
  }], repository);

  const report = await service.runSkillProposal({ scope, evidenceIds });
  assert.equal(report.created.length, 1);
  assert.equal(report.created[0]!.name, "fresh-name");
  assert.equal(report.rejected.length, 1);
  assert.ok(report.rejected[0]!.reasons[0]!.includes("创建 Draft 失败"));
  assert.equal(skills.list(scope).length, 2);
});

test("固定 Evidence 与 Mock Provider 下提案结果完全可复现", async () => {
  const evidenceContents = ["用户偏好中文注释。", "项目使用 Node 22。"];
  const candidates = {
    candidates: [
      { layer: "l1", content: "偏好中文注释", confidence: 0.9, reason: "明确偏好", evidenceRefs: [1] },
      { layer: "l1", content: "运行时为 Node 22", confidence: 0.85, reason: "技术事实", evidenceRefs: [2] },
    ],
  };

  const runOnce = () => {
    const repository = buildRepository();
    const evidenceIds = seedEvidence(repository, evidenceContents);
    const { service } = buildService([{ type: "ok", data: candidates }], repository);
    return service.runMemoryProposal({ scope, evidenceIds });
  };

  const first = await runOnce();
  const second = await runOnce();
  // 固定 ID 生成器 + 相同输入：产出（含 ID）逐字段一致
  assert.deepEqual(first.created, second.created);
  assert.deepEqual(first.rejected, second.rejected);
});

test("HTTP：evidence/get 按作用域返回原文，proposals/run 创建 Draft，未配置 Provider 时 503", async () => {
  const repository = buildRepository();
  const evidenceIds = seedEvidence(repository, ["用户偏好中文沟通。"]);
  const accessKey = "proposal-http-key";

  const startServer = async (withProvider: boolean) => {
    const server = createMemorySkillsServer({
      repository,
      accessKey,
      ...(withProvider
        ? { llmProvider: new MockLlmProvider({ steps: [{ type: "ok", data: { candidates: [{ layer: "l1", content: "偏好中文沟通", confidence: 0.9, reason: "明确偏好", evidenceRefs: [1] }] } }], model: "mock-model" }) }
        : {}),
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return server;
  };

  const headers = { authorization: `Bearer ${accessKey}`, "content-type": "application/json" };

  const noProviderServer = await startServer(false);
  try {
    const { port } = noProviderServer.address() as AddressInfo;
    const base = `http://127.0.0.1:${port}`;
    const unavailable = await fetch(`${base}/v1/proposals/memory/run`, {
      method: "POST", headers, body: JSON.stringify({ scope }),
    });
    assert.equal(unavailable.status, 503);
  } finally {
    noProviderServer.close();
  }

  const server = await startServer(true);
  try {
    const { port } = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${port}`;

    const evidenceResponse = await fetch(`${base}/v1/evidence/get`, {
      method: "POST", headers, body: JSON.stringify({ scope, ids: evidenceIds }),
    });
    const evidenceBody = await evidenceResponse.json() as { items: Array<{ id: string; content: string }> };
    assert.equal(evidenceResponse.status, 200);
    assert.deepEqual(evidenceBody.items.map((item) => item.id), evidenceIds);
    assert.equal(evidenceBody.items[0]!.content, "用户偏好中文沟通。");

    const reportResponse = await fetch(`${base}/v1/proposals/memory/run`, {
      method: "POST", headers, body: JSON.stringify({ scope }),
    });
    const report = await reportResponse.json() as { created: Array<{ governance: { status: string } }> };
    assert.equal(reportResponse.status, 200);
    assert.equal(report.created.length, 1);
    assert.equal(report.created[0]!.governance.status, "draft");
  } finally {
    server.close();
  }
});
