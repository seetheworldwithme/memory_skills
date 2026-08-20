import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import type { Scope } from "../../governance/types.js";
import { MemorySkillsHttpClient } from "./http-client.js";

/** MCP 工具名集合；新增工具必须同时更新测试与 docs/integrations/mcp-contract.md。 */
export type McpToolName = "recall_context" | "recall_memory" | "search_skills" | "get_skill";

/** 只读工具注解：所有宿主看到的都一致，且全部能力均为只读。 */
export const readOnlyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

/** 工具目录条目：名称、说明、输入/输出 Schema 与只读标记的唯一事实来源。 */
export interface McpToolDefinition {
  name: McpToolName;
  title: string;
  description: string;
  inputSchema: z.ZodType;
  /** 输出 Schema 约束 structuredContent 的关键契约字段；loose 模式允许服务端向后兼容地新增字段。 */
  outputSchema?: z.ZodType;
}

const recalledMemoryOutput = z.object({
  id: z.string(),
  truncated: z.boolean(),
  match: z.object({
    strategy: z.string(),
    score: z.number(),
    matchedTerms: z.array(z.string()),
  }).loose(),
}).loose();

const skillOutput = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  status: z.string(),
}).loose();

const recalledSkillOutput = skillOutput.extend({ truncated: z.boolean() });

const contextRecallOutput = z.object({
  contractVersion: z.number(),
  requestId: z.string(),
  query: z.string(),
  memories: z.array(recalledMemoryOutput),
  skills: z.array(recalledSkillOutput),
  budget: z.object({
    maxMemoryResults: z.number(),
    maxMemoryChars: z.number(),
    maxSkillResults: z.number(),
    maxSkillChars: z.number(),
    usedMemoryChars: z.number(),
    usedSkillChars: z.number(),
  }).loose(),
  truncated: z.boolean(),
  warnings: z.array(z.object({ code: z.string(), message: z.string() }).loose()),
}).loose();

const recallContextInput = z.object({
  query: z.string().trim().min(1).describe("The user's request or a concise search phrase"),
  maxMemoryResults: z.number().int().positive().max(20).optional(),
  maxMemoryChars: z.number().int().positive().max(50_000).optional(),
  maxSkillResults: z.number().int().positive().max(20).optional(),
  maxSkillChars: z.number().int().positive().max(50_000).optional(),
});

const recallMemoryInput = z.object({
  query: z.string().trim().min(1),
  maxResults: z.number().int().positive().max(20).optional(),
  maxTotalChars: z.number().int().positive().max(50_000).optional(),
});

const searchSkillsInput = z.object({
  query: z.string().trim().min(1),
});

const getSkillInput = z.object({
  id: z.string().trim().min(1),
});

/** 工具目录：stdio 与未来的远程 MCP 必须共用这一份定义，不得出现第二套工具行为。 */
export const MCP_TOOL_CATALOG: readonly McpToolDefinition[] = [
  {
    name: "recall_context",
    title: "Recall Memory and Skills",
    description: "Retrieve relevant verified memories and skills together for an agent request. Prefer this tool for normal context lookup.",
    inputSchema: recallContextInput,
    outputSchema: contextRecallOutput,
  },
  {
    name: "recall_memory",
    title: "Recall Memory",
    description: "Retrieve relevant governed memory assets without Skill documents.",
    inputSchema: recallMemoryInput,
    outputSchema: z.object({ items: z.array(recalledMemoryOutput) }).loose(),
  },
  {
    name: "search_skills",
    title: "Search Skills",
    description: "Search governed Skill documents by trigger, name, description, and content.",
    inputSchema: searchSkillsInput,
    outputSchema: z.object({ items: z.array(skillOutput) }).loose(),
  },
  {
    name: "get_skill",
    title: "Get Skill",
    description: "Load one verified Skill document by ID after discovering it through context recall or Skill search.",
    inputSchema: getSkillInput,
    outputSchema: skillOutput,
  },
];

/** 工具执行上下文：HTTP 客户端与服务端绑定的作用域。 */
export interface McpToolHandlerContext {
  client: MemorySkillsHttpClient;
  defaultScope: Scope;
}

/** 目录条目与其执行器的配对；执行器负责把输入映射为受治理的 HTTP 调用。 */
export interface McpToolRegistration {
  definition: McpToolDefinition;
  invoke(input: unknown, context: McpToolHandlerContext): Promise<object>;
}

/**
 * 构建全部工具注册项。
 * 关键策略：作用域永远取 context.defaultScope（服务端环境绑定），
 * 工具输入中的任何作用域类字段都会被 Schema 剥离，调用方无法覆盖作用域或状态策略。
 */
export function createToolRegistrations(): McpToolRegistration[] {
  return [
    {
      definition: MCP_TOOL_CATALOG[0]!,
      invoke: async (raw, { client, defaultScope }) => {
        const input = recallContextInput.parse(raw);
        return client.recallContext({
          query: input.query,
          scope: defaultScope,
          ...(input.maxMemoryResults === undefined ? {} : { maxMemoryResults: input.maxMemoryResults }),
          ...(input.maxMemoryChars === undefined ? {} : { maxMemoryChars: input.maxMemoryChars }),
          ...(input.maxSkillResults === undefined ? {} : { maxSkillResults: input.maxSkillResults }),
          ...(input.maxSkillChars === undefined ? {} : { maxSkillChars: input.maxSkillChars }),
        });
      },
    },
    {
      definition: MCP_TOOL_CATALOG[1]!,
      invoke: async (raw, { client, defaultScope }) => {
        const input = recallMemoryInput.parse(raw);
        return client.recallMemory({
          query: input.query,
          scope: defaultScope,
          ...(input.maxResults === undefined ? {} : { maxResults: input.maxResults }),
          ...(input.maxTotalChars === undefined ? {} : { maxTotalChars: input.maxTotalChars }),
        });
      },
    },
    {
      definition: MCP_TOOL_CATALOG[2]!,
      invoke: async (raw, { client, defaultScope }) => {
        const input = searchSkillsInput.parse(raw);
        return client.searchSkills({ query: input.query, scope: defaultScope });
      },
    },
    {
      definition: MCP_TOOL_CATALOG[3]!,
      invoke: async (raw, { client, defaultScope }) => {
        const input = getSkillInput.parse(raw);
        const skill = await client.getSkill(input.id, defaultScope);
        // 状态策略在服务端强制执行：Draft（或任何非 verified 状态）绝不对 Agent 暴露
        if (skill.status !== "verified") throw new Error(`skill is not verified: ${input.id}`);
        return skill;
      },
    },
  ];
}

/** 把工具目录注册到 McpServer；stdio 与未来远程入口都必须且只能使用这一入口。 */
export function registerMemorySkillsTools(
  server: McpServer,
  options: McpToolHandlerContext,
): void {
  for (const { definition, invoke } of createToolRegistrations()) {
    server.registerTool(
      definition.name,
      {
        title: definition.title,
        description: definition.description,
        inputSchema: definition.inputSchema,
        ...(definition.outputSchema === undefined ? {} : { outputSchema: definition.outputSchema }),
        annotations: readOnlyAnnotations,
      },
      async (input: unknown) => toolResult(await invoke(input, options)),
    );
  }
}

/** structuredContent 与文本块承载同一份数据；文本块仅为兼容展示。 */
function toolResult(value: object) {
  const structuredContent = JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
  return {
    content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }],
    structuredContent,
  };
}
