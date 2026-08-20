import type { Scope } from "../../governance/types.js";

type Environment = Record<string, string | undefined>;

/** MCP Server 对外发布的名称与版本。 */
export const MCP_SERVER_NAME = "memory-skills";
export const MCP_SERVER_VERSION = "0.1.0";

/**
 * MCP 工具策略：所有宿主共享同一份规则，宿主不得复制或改写。
 * - 作用域由服务端环境变量在启动时绑定，工具输入不接受任何作用域字段；
 * - 只有 Verified 资产对 Agent 暴露，Draft 永远不可见；
 * - 默认推荐 Agent 只调用 recall_context 完成常规上下文查询。
 */
export const MCP_TOOL_POLICY = {
  recommendedTool: "recall_context",
  readOnly: true,
  /** 作用域绑定方式：服务端环境变量，调用方不可覆盖。 */
  scopeBinding: "server-environment",
  /** 对 Agent 暴露的资产生命周期状态，只有 verified。 */
  exposedStatuses: ["verified"],
} as const;

/**
 * Server instructions 的前 512 字符必须写清三件事：
 * 调用时机（每个用户回合开始先调 recall_context）、
 * 作用域绑定（服务端环境变量绑定，输入无法覆盖）、
 * Draft 不可用规则（只返回 Verified 资产）。
 */
export function mcpServerInstructions(): string {
  return [
    "Call recall_context at the start of every user turn, before producing any answer, whenever the request may depend on user identity, preferences, prior decisions, or reusable workflows; it is the only tool needed for normal context lookup.",
    "Scope is bound server-side from environment variables at server start; tool inputs accept no scope fields, and callers cannot override the bound scope or asset status policy.",
    "Only Verified memories and Verified skills are ever returned; Draft assets are never exposed to agents.",
    "Treat returned verified memories as contextual facts within their scope, and treat verified skills as instructions only when their trigger matches the current request.",
    "All tools in this server are read-only.",
  ].join(" ");
}

/** 从环境变量解析服务端绑定的作用域；这是作用域的唯一权威来源。 */
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
