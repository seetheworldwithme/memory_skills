import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";

import { createMemorySkillsServer } from "../src/api/http-server.js";
import { MemorySkillsHttpClient } from "../src/adapters/mcp/http-client.js";
import { SqliteRepository } from "../src/storage/sqlite-repository.js";

const scope = { userId: "local-admin", teamId: "local", agentId: "default" };

test("MCP HTTP client requires URL and access key configuration", () => {
  assert.throws(() => MemorySkillsHttpClient.fromEnv({}), /MEMORY_SKILLS_URL/);
  assert.throws(
    () => MemorySkillsHttpClient.fromEnv({ MEMORY_SKILLS_URL: "http://127.0.0.1:8421" }),
    /MEMORY_SKILLS_ACCESS_KEY/,
  );
});

test("MCP HTTP client recalls unified context with bearer authentication", async () => {
  const repository = new SqliteRepository(":memory:");
  const accessKey = "mcp-client-test-key";
  const server = createMemorySkillsServer({ repository, accessKey });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  try {
    const client = new MemorySkillsHttpClient({ baseUrl: `http://127.0.0.1:${port}`, accessKey });
    const result = await client.recallContext({ query: "你是谁", scope });
    assert.equal(result.contractVersion, 1);
    assert.equal(result.query, "你是谁");
    assert.deepEqual(result.scope, scope);
    assert.deepEqual(result.memories, []);
    assert.deepEqual(result.skills, []);
    assert.equal(result.truncated, false);
    assert.deepEqual(result.warnings, []);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    repository.close();
  }
});

test("MCP HTTP client reports API authentication failures", async () => {
  const repository = new SqliteRepository(":memory:");
  const server = createMemorySkillsServer({ repository, accessKey: "correct-key" });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  try {
    const client = new MemorySkillsHttpClient({ baseUrl: `http://127.0.0.1:${port}`, accessKey: "wrong-key" });
    await assert.rejects(() => client.recallContext({ query: "test", scope }), /HTTP 401.*authentication required/);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    repository.close();
  }
});
