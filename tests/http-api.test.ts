import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";

import { createMemorySkillsServer } from "../src/api/http-server.js";
import { SqliteRepository } from "../src/storage/sqlite-repository.js";
import { CONTRACT_VERSION } from "../src/context/contract.js";
import { contractQuery, contractScope, seedContractAssets } from "./helpers/contract-fixtures.js";

test("HTTP API exposes capture, governance transition, and recall", async () => {
  const repository = new SqliteRepository(":memory:");
  const accessKey = "api-test-key";
  const server = createMemorySkillsServer({ repository, accessKey });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  const scope = { userId: "alice", teamId: "team-a", agentId: "agent-a" };

  try {
    const health = await fetch(`${base}/health`).then((response) => response.json());
    assert.deepEqual(health, { ok: true });

    const evidence = await post(`${base}/v1/evidence`, {
      id: "api-ev-1",
      scope,
      role: "user",
      content: "Always show verification evidence",
    }, accessKey);
    assert.equal(evidence.id, "api-ev-1");

    const memory = await post(`${base}/v1/memories`, {
      id: "api-mem-1",
      layer: "l1",
      scope,
      content: "Alice expects verification evidence",
      confidence: 0.95,
      reason: "explicit instruction",
      sourceEvidenceIds: ["api-ev-1"],
    }, accessKey);
    assert.equal(memory.governance.status, "draft");

    await post(`${base}/v1/memories/api-mem-1/status`, { scope, target: "verified" }, accessKey);
    const recall = await post(`${base}/v1/recall`, { query: "verification", scope }, accessKey);
    assert.equal(recall.items.length, 1);
    assert.equal(recall.items[0].id, "api-mem-1");

    const listed = await post(`${base}/v1/memories/list`, { scope }, accessKey);
    assert.equal(listed.items.length, 1);

    const missing = await fetch(`${base}/v1/memories/get`, {
      method: "POST",
      headers: { authorization: `Bearer ${accessKey}`, "content-type": "application/json" },
      body: JSON.stringify({ id: "missing", scope }),
    });
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).error, "NOT_FOUND");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    repository.close();
  }
});

test("HTTP API recalls memory and skills through one context endpoint", async () => {
  const repository = new SqliteRepository(":memory:");
  seedContractAssets(repository);
  const accessKey = "context-api-test-key";
  const server = createMemorySkillsServer({ repository, accessKey });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;

  try {
    const context = await post(`${base}/v1/context/recall`, {
      query: contractQuery,
      scope: contractScope,
      maxMemoryResults: 5,
      maxMemoryChars: 4_000,
      maxSkillResults: 3,
      maxSkillChars: 8_000,
    }, accessKey);

    assert.equal(context.contractVersion, CONTRACT_VERSION);
    assert.ok(typeof context.requestId === "string" && context.requestId.length > 0);
    assert.equal(context.memories.length, 1);
    assert.equal(context.memories[0].id, "contract-mem-1");
    assert.equal(context.memories[0].match.strategy, "lexical");
    assert.ok(context.memories[0].match.matchedTerms.length > 0);
    assert.equal(context.skills.length, 1);
    assert.equal(context.skills[0].id, "contract-skill-1");
    assert.equal(context.skills[0].truncated, false);
    assert.equal(context.truncated, false);
    assert.deepEqual(context.warnings, []);
    assert.equal(context.budget.usedMemoryChars, context.memories[0].content.length);

    const blank = await fetch(`${base}/v1/context/recall`, {
      method: "POST",
      headers: { authorization: `Bearer ${accessKey}`, "content-type": "application/json" },
      body: JSON.stringify({ query: "   ", scope: contractScope }),
    });
    assert.equal(blank.status, 400);
    assert.match((await blank.json()).message, /query must not be empty/);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    repository.close();
  }
});

async function post(url: string, body: unknown, accessKey: string): Promise<any> {
  const response = await fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${accessKey}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  assert.equal(response.status, 200, text);
  return JSON.parse(text);
}
