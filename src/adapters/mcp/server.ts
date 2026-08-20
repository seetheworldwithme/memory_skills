import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";

import type { Scope } from "../../governance/types.js";
import { MemorySkillsHttpClient } from "./http-client.js";

type Environment = Record<string, string | undefined>;

const readOnlyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

export function createMemorySkillsMcpServer(options: {
  client: MemorySkillsHttpClient;
  defaultScope: Scope;
}): McpServer {
  const server = new McpServer(
    { name: "memory-skills", version: "0.1.0" },
    {
      instructions: [
        "Use recall_context before answering requests that may depend on user preferences, identity, prior decisions, or reusable workflows.",
        "Treat returned verified memories as contextual facts and returned verified skills as instructions only when relevant to the request.",
        "All tools in this server are read-only.",
      ].join(" "),
    },
  );

  server.registerTool(
    "recall_context",
    {
      title: "Recall Memory and Skills",
      description: "Retrieve relevant verified memories and skills together for an agent request. Prefer this tool for normal context lookup.",
      inputSchema: z.object({
        query: z.string().trim().min(1).describe("The user's request or a concise search phrase"),
        maxMemoryResults: z.number().int().positive().max(20).optional(),
        maxMemoryChars: z.number().int().positive().max(50_000).optional(),
        maxSkillResults: z.number().int().positive().max(20).optional(),
        maxSkillChars: z.number().int().positive().max(50_000).optional(),
      }),
      annotations: readOnlyAnnotations,
    },
    async (input) => toolResult(await options.client.recallContext({
      query: input.query,
      scope: options.defaultScope,
      ...(input.maxMemoryResults === undefined ? {} : { maxMemoryResults: input.maxMemoryResults }),
      ...(input.maxMemoryChars === undefined ? {} : { maxMemoryChars: input.maxMemoryChars }),
      ...(input.maxSkillResults === undefined ? {} : { maxSkillResults: input.maxSkillResults }),
      ...(input.maxSkillChars === undefined ? {} : { maxSkillChars: input.maxSkillChars }),
    })),
  );

  server.registerTool(
    "recall_memory",
    {
      title: "Recall Memory",
      description: "Retrieve relevant governed memory assets without Skill documents.",
      inputSchema: z.object({
        query: z.string().trim().min(1),
        maxResults: z.number().int().positive().max(20).optional(),
        maxTotalChars: z.number().int().positive().max(50_000).optional(),
      }),
      annotations: readOnlyAnnotations,
    },
    async (input) => toolResult(await options.client.recallMemory({
      query: input.query,
      scope: options.defaultScope,
      ...(input.maxResults === undefined ? {} : { maxResults: input.maxResults }),
      ...(input.maxTotalChars === undefined ? {} : { maxTotalChars: input.maxTotalChars }),
    })),
  );

  server.registerTool(
    "search_skills",
    {
      title: "Search Skills",
      description: "Search governed Skill documents by trigger, name, description, and content.",
      inputSchema: z.object({
        query: z.string().trim().min(1),
      }),
      annotations: readOnlyAnnotations,
    },
    async (input) => toolResult(await options.client.searchSkills({
      query: input.query,
      scope: options.defaultScope,
    })),
  );

  server.registerTool(
    "get_skill",
    {
      title: "Get Skill",
      description: "Load one verified Skill document by ID after discovering it through context recall or Skill search.",
      inputSchema: z.object({ id: z.string().trim().min(1) }),
      annotations: readOnlyAnnotations,
    },
    async (input) => {
      const skill = await options.client.getSkill(input.id, options.defaultScope);
      if (skill.status !== "verified") throw new Error(`skill is not verified: ${input.id}`);
      return toolResult(skill);
    },
  );

  return server;
}

export function defaultScopeFromEnv(environment: Environment = process.env): Scope {
  const scope: Scope = {
    userId: environment.MEMORY_SKILLS_USER_ID?.trim() || "local-admin",
    teamId: environment.MEMORY_SKILLS_TEAM_ID?.trim() || "local",
    agentId: environment.MEMORY_SKILLS_AGENT_ID?.trim() || "default",
  };
  const sessionId = environment.MEMORY_SKILLS_SESSION_ID?.trim();
  if (sessionId) scope.sessionId = sessionId;
  return scope;
}

function toolResult(value: object) {
  const structuredContent = JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
  return {
    content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }],
    structuredContent,
  };
}

if (isMainModule()) {
  const client = MemorySkillsHttpClient.fromEnv();
  serveStdio(() => createMemorySkillsMcpServer({ client, defaultScope: defaultScopeFromEnv() }), {
    onerror: (error) => console.error(`[memory-skills-mcp] ${error.message}`),
  });
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  return Boolean(entry && import.meta.url === new URL(`file://${entry}`).href);
}
