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
