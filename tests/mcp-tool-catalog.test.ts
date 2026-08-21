import assert from "node:assert/strict";
import test from "node:test";
import * as z from "zod/v4";

import type { Scope } from "../src/governance/types.js";
import { MemorySkillsHttpClient } from "../src/adapters/mcp/http-client.js";
import {
  MCP_TOOL_CATALOG,
  createToolRegistrations,
  readOnlyAnnotations,
} from "../src/adapters/mcp/tool-catalog.js";
import { MCP_TOOL_POLICY, mcpServerInstructions } from "../src/adapters/mcp/tool-policy.js";
import { SqliteRepository } from "../src/storage/sqlite-repository.js";
import { MemoryService } from "../src/memory/memory-service.js";
import { SkillService } from "../src/skills/skill-service.js";
import { ContextService } from "../src/context/context-service.js";

const boundScope: Scope = { userId: "bound-user", teamId: "bound-team", agentId: "bound-agent" };

/** 记录调用参数的假 HTTP 客户端，用于断言服务端策略。 */
function fakeClient(overrides: Partial<MemorySkillsHttpClient> = {}): MemorySkillsHttpClient {
  const calls: Record<string, unknown[]> = {};
  const record = (method: string) => (...args: unknown[]) => {
    calls[method] = args;
    return Promise.resolve({ items: [] });
  };
  return Object.assign(
    {
      recallContext: record("recallContext"),
      recallMemory: record("recallMemory"),
      searchSkills: record("searchSkills"),
      getSkill: record("getSkill"),
      calls: () => calls,
    },
    overrides,
  ) as unknown as MemorySkillsHttpClient;
}

test("工具目录恰好暴露四个只读工具，且目录是唯一的 Schema 来源", () => {
  assert.deepEqual(
    MCP_TOOL_CATALOG.map((tool) => tool.name),
    ["recall_context", "recall_memory", "search_skills", "get_skill"],
  );
  for (const tool of MCP_TOOL_CATALOG) {
    assert.ok(tool.title.length > 0);
    assert.ok(tool.description.length > 0);
    assert.ok(tool.inputSchema instanceof z.ZodType);
    // 每个工具都必须声明输出 Schema，保证 structuredContent 的结构对宿主可见
    assert.ok(tool.outputSchema instanceof z.ZodType, `${tool.name} 缺少 outputSchema`);
  }
  assert.deepEqual(MCP_TOOL_POLICY.exposedStatuses, ["verified"]);
  assert.equal(MCP_TOOL_POLICY.recommendedTool, "recall_context");
  assert.deepEqual(readOnlyAnnotations, {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  });
});

test("所有宿主拿到相同工具 Schema：两次构建的注册项定义完全一致", () => {
  const strip = (registrations: ReturnType<typeof createToolRegistrations>) =>
    registrations.map(({ definition }) => ({
      name: definition.name,
      title: definition.title,
      description: definition.description,
      inputSchema: definition.inputSchema,
      outputSchema: definition.outputSchema,
    }));
  const first = strip(createToolRegistrations());
  const second = strip(createToolRegistrations());
  assert.deepEqual(first, second);
  assert.equal(first.length, 4);
});

test("instructions 前 512 字符写清调用时机、作用域绑定与 Draft 不可用规则", () => {
  const head = mcpServerInstructions().slice(0, 512);
  assert.ok(head.includes("recall_context"), "前 512 字符必须包含推荐工具调用时机");
  assert.ok(head.includes("Scope is bound server-side"), "前 512 字符必须写清作用域由服务端绑定");
  assert.ok(head.includes("cannot override"), "前 512 字符必须写清调用方不能覆盖策略");
  assert.ok(head.includes("Verified") && head.includes("Draft"), "前 512 字符必须写清 Draft 不可用");
});

test("工具输入无法覆盖作用域：混入的作用域字段被剥离，实际使用服务端绑定值", async () => {
  const client = fakeClient();
  const context = { client, defaultScope: boundScope };
  const registrations = createToolRegistrations();
  const recallContext = registrations.find(({ definition }) => definition.name === "recall_context")!;

  await recallContext.invoke({
    query: "用户问我是谁",
    userId: "foreign-user",
    teamId: "foreign-team",
    agentId: "foreign-agent",
    sessionId: "foreign-session",
    scope: { userId: "foreign-user", teamId: "foreign-team", agentId: "foreign-agent" },
    includeDraft: true,
  }, context);

  const input = (client as unknown as { calls: () => Record<string, unknown[]> }).calls().recallContext![0] as Record<string, unknown>;
  assert.deepEqual(input.scope, boundScope);
  assert.equal(input.includeDraft, undefined);
  assert.ok(!("userId" in input) && !("teamId" in input) && !("sessionId" in input));
});

test("get_skill 只返回 Verified Skill，非 Verified 一律拒绝", async () => {
  const client = fakeClient({
    getSkill: (() => Promise.resolve({
      id: "draft-skill",
      name: "draft",
      description: "draft skill",
      content: "x",
      version: 1,
      status: "draft",
      sources: [],
      createdAt: "2026-08-20T00:00:00.000Z",
      updatedAt: "2026-08-20T00:00:00.000Z",
      scope: boundScope,
    })) as unknown as MemorySkillsHttpClient["getSkill"],
  });
  const getSkill = createToolRegistrations().find(({ definition }) => definition.name === "get_skill")!;

  await assert.rejects(() => getSkill.invoke({ id: "draft-skill" }, { client, defaultScope: boundScope }), /not verified/);
});

test("输入 Schema 保持既有校验：空查询被拒绝，预算字段有上限", () => {
  const recallContext = MCP_TOOL_CATALOG.find((tool) => tool.name === "recall_context")!;
  const schema = recallContext.inputSchema as z.ZodObject;
  assert.ok(!schema.safeParse({ query: "   " }).success);
  assert.ok(!schema.safeParse({ query: "q", maxMemoryResults: 21 }).success);
  assert.ok(schema.safeParse({ query: "q", maxMemoryResults: 20 }).success);
  assert.ok(schema.safeParse({ query: "q", userId: "x" }).success, "未知字段被剥离而不是报错");
});

test("服务层真实召回输出满足各工具 outputSchema：命中必须带 match 元数据", async () => {
  // 回归背景：recall_memory 的后端 /v1/recall 曾返回不含 match 对象的条目，
  // 非空命中被 SDK 服务端输出校验整条拒绝（空结果不触发校验，假客户端返回
  // 空数组掩盖了该缺陷）。本用例用真实服务链路的输出直接对 outputSchema
  // 做解析，复现 SDK 的校验行为，任何字段缺失都会在测试层暴露。
  const repository = new SqliteRepository(":memory:");
  try {
    const memory = new MemoryService(repository);
    const skills = new SkillService(repository);
    const context = new ContextService(memory, skills);

    memory.capture({ id: "match-ev-1", scope: boundScope, role: "user", content: "用户偏好中文沟通" });
    memory.propose({
      id: "match-mem-1", layer: "l1", scope: boundScope, content: "用户偏好中文沟通",
      confidence: 0.9, reason: "回归测试种子", sourceEvidenceIds: ["match-ev-1"],
    });
    memory.transition("match-mem-1", boundScope, "verified");

    const client = fakeClient({
      recallMemory: () => Promise.resolve({ items: memory.recall({ query: "中文沟通", scope: boundScope }) }),
      recallContext: () => context.recall({ query: "中文沟通", scope: boundScope }),
    });
    const handlerContext = { client, defaultScope: boundScope };
    const byName = new Map(createToolRegistrations().map((registration) => [registration.definition.name, registration]));

    const recallMemory = byName.get("recall_memory")!;
    const memoryOutput = await recallMemory.invoke({ query: "中文沟通" }, handlerContext);
    // outputSchema 声明为宽泛的 z.ZodType，parse 结果收窄到断言所需的最小结构
    const parsedMemory = recallMemory.definition.outputSchema!.parse(memoryOutput) as {
      items: Array<{ match: { strategy: string; matchedTerms: string[] } }>;
    };
    assert.equal(parsedMemory.items.length, 1, "种子记忆必须被召回");
    assert.equal(parsedMemory.items[0]!.match.strategy, "lexical");
    assert.ok(parsedMemory.items[0]!.match.matchedTerms.length > 0, "命中片段非空");

    const recallContext = byName.get("recall_context")!;
    const contextOutput = await recallContext.invoke({ query: "中文沟通" }, handlerContext);
    const parsedContext = recallContext.definition.outputSchema!.parse(contextOutput) as {
      memories: Array<{ match: { strategy: string } }>;
    };
    assert.equal(parsedContext.memories.length, 1);
    assert.equal(parsedContext.memories[0]!.match.strategy, "lexical");
  } finally {
    repository.close();
  }
});
