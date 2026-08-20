import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

import { createMemorySkillsServer } from "../src/api/http-server.js";
import { MemoryService } from "../src/memory/memory-service.js";
import { SkillService } from "../src/skills/skill-service.js";
import { SqliteRepository } from "../src/storage/sqlite-repository.js";
import { CONTRACT_VERSION } from "../src/context/contract.js";
import { contractQuery, contractScope, seedContractAssets } from "./helpers/contract-fixtures.js";

test("stdio MCP server exposes read-only context tools", async () => {
  const repository = new SqliteRepository(":memory:");
  seedContractAssets(repository);
  const memory = new MemoryService(repository);
  const skills = new SkillService(repository);
  skills.create({
    id: "mcp-draft-skill",
    scope: contractScope,
    name: "draft-only",
    description: "Unreviewed draft instructions",
    content: "---\nname: draft-only\ndescription: Unreviewed draft instructions\n---\n\n# Workflow\nDo not expose this draft.",
    sourceEvidenceIds: [],
  });

  const accessKey = "mcp-server-test-key";
  const httpServer = createMemorySkillsServer({ repository, accessKey });
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const { port } = httpServer.address() as AddressInfo;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", "src/adapters/mcp/server.ts"],
    cwd: process.cwd(),
    stderr: "pipe",
    env: {
      MEMORY_SKILLS_URL: `http://127.0.0.1:${port}`,
      MEMORY_SKILLS_ACCESS_KEY: accessKey,
      MEMORY_SKILLS_USER_ID: contractScope.userId,
      MEMORY_SKILLS_TEAM_ID: contractScope.teamId,
      MEMORY_SKILLS_AGENT_ID: contractScope.agentId,
    },
  });
  const client = new Client({ name: "memory-skills-test", version: "1.0.0" });

  try {
    await client.connect(transport);
    const listed = await client.listTools();
    assert.deepEqual(
      listed.tools.map((tool) => tool.name).sort(),
      ["get_skill", "recall_context", "recall_memory", "search_skills"],
    );
    assert.ok(listed.tools.every((tool) => tool.annotations?.readOnlyHint === true));

    const result = await client.callTool({
      name: "recall_context",
      arguments: {
        query: contractQuery,
        userId: "foreign-user",
        teamId: "foreign-team",
        agentId: "foreign-agent",
      },
    });
    assert.equal(result.isError, undefined);
    const text = result.content.find((block) => block.type === "text");
    assert.ok(text && text.type === "text");
    const context = JSON.parse(text.text);
    assert.equal(context.contractVersion, CONTRACT_VERSION);
    assert.ok(typeof context.requestId === "string" && context.requestId.length > 0);
    assert.equal(context.memories[0].id, "contract-mem-1");
    assert.equal(context.memories[0].match.strategy, "lexical");
    assert.equal(context.skills[0].id, "contract-skill-1");
    assert.deepEqual(result.structuredContent, context);

    const blank = await client.callTool({ name: "recall_context", arguments: { query: "   " } });
    assert.equal(blank.isError, true);

    const draft = await client.callTool({ name: "get_skill", arguments: { id: "mcp-draft-skill" } });
    assert.equal(draft.isError, true);
  } finally {
    await client.close();
    await new Promise<void>((resolve, reject) => httpServer.close((error) => error ? reject(error) : resolve()));
    repository.close();
  }
});
