import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";

import { MemorySkillsHttpClient } from "./http-client.js";
import { registerMemorySkillsTools } from "./tool-catalog.js";
import {
  MCP_SERVER_NAME,
  MCP_SERVER_VERSION,
  defaultScopeFromEnv,
  mcpServerInstructions,
} from "./tool-policy.js";

/**
 * 创建 memory-skills MCP Server。
 * 工具定义来自 tool-catalog.ts（单一目录），策略与指令来自 tool-policy.ts，
 * 本文件只负责组装，不承载任何业务规则。
 */
export function createMemorySkillsMcpServer(options: {
  client: MemorySkillsHttpClient;
  defaultScope: Parameters<typeof registerMemorySkillsTools>[1]["defaultScope"];
}): McpServer {
  const server = new McpServer(
    { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
    { instructions: mcpServerInstructions() },
  );
  registerMemorySkillsTools(server, options);
  return server;
}

// 作用域解析已迁移到 tool-policy.ts，这里保留导出以兼容既有引用
export { defaultScopeFromEnv } from "./tool-policy.js";

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
