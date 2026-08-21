import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

import { createMcpHttpServer, MCP_HTTP_PATH } from "../src/adapters/mcp/http-server.js";
import { MemorySkillsHttpClient } from "../src/adapters/mcp/http-client.js";
import { AuthService } from "../src/auth/auth-service.js";
import { sha256Hex } from "../src/auth/access-key.js";
import { createMemorySkillsServer } from "../src/api/http-server.js";
import { CONTRACT_VERSION } from "../src/context/contract.js";
import type { Scope } from "../src/governance/types.js";
import { MemoryService } from "../src/memory/memory-service.js";
import type { AuditDeniedEvent, ObservabilityEvent } from "../src/observability/events.js";
import type { EventSink } from "../src/observability/event-sink.js";
import { AuditService } from "../src/security/audit-service.js";
import { DEFAULT_RATE_LIMIT_RULES, RateLimiter } from "../src/security/rate-limit.js";
import { SqliteRepository } from "../src/storage/sqlite-repository.js";

const ACCESS_KEY = "remote-mcp-test-access-key";
const READER_TOKEN = "team-reader-token-for-bob";
const BOB_SCOPE: Scope = { userId: "bob", teamId: "acme", agentId: "default" };
const BOB_QUERY = "bob 的主题偏好是什么";

interface TestStack {
  apiBase: string;
  mcpBase: string;
  events: ObservabilityEvent[];
  close: () => Promise<void>;
}

/** 起一套 api + 远程 MCP 双服务；bob@acme 作用域预置一条 Verified 记忆。 */
async function startStack(options: {
  rateLimiter?: RateLimiter;
  allowedHosts?: string[];
} = {}): Promise<TestStack> {
  const repository = new SqliteRepository(":memory:");
  const memory = new MemoryService(repository);
  const evidence = memory.capture({
    id: "remote-ev-1",
    scope: BOB_SCOPE,
    role: "user",
    content: "bob 偏好深色主题",
  });
  const asset = memory.propose({
    id: "bob-mem-1",
    layer: "l1",
    scope: BOB_SCOPE,
    content: "bob 偏好深色主题",
    confidence: 0.9,
    reason: "explicit preference",
    sourceEvidenceIds: [evidence.id],
  });
  memory.transition(asset.id, BOB_SCOPE, "verified");

  const events: ObservabilityEvent[] = [];
  const sink: EventSink = { emit: (event) => { events.push(event); } };

  const apiServer = createMemorySkillsServer({ repository, accessKey: ACCESS_KEY, eventSink: sink });
  await new Promise<void>((resolve) => apiServer.listen(0, "127.0.0.1", resolve));
  const apiPort = (apiServer.address() as AddressInfo).port;

  const authService = new AuthService({
    accessKey: ACCESS_KEY,
    teamTokens: [{
      id: "reader-bob",
      tokenHash: sha256Hex(READER_TOKEN),
      userId: "bob",
      teamId: "acme",
      roles: ["reader"],
    }],
  });
  const mcpServer = createMcpHttpServer({
    client: new MemorySkillsHttpClient({ baseUrl: `http://127.0.0.1:${apiPort}`, accessKey: ACCESS_KEY }),
    authService,
    security: {
      ...(options.rateLimiter ? { rateLimiter: options.rateLimiter } : {}),
      audit: new AuditService(sink),
    },
    ...(options.allowedHosts ? { allowedHosts: options.allowedHosts } : {}),
    environment: {},
  });
  await new Promise<void>((resolve) => mcpServer.listen(0, "127.0.0.1", resolve));
  const mcpPort = (mcpServer.address() as AddressInfo).port;

  return {
    apiBase: `http://127.0.0.1:${apiPort}`,
    mcpBase: `http://127.0.0.1:${mcpPort}`,
    events,
    close: async () => {
      await new Promise<void>((resolve, reject) => mcpServer.close((error) => error ? reject(error) : resolve()));
      await new Promise<void>((resolve, reject) => apiServer.close((error) => error ? reject(error) : resolve()));
      repository.close();
    },
  };
}

/** 用指定 Bearer Token 建立真实 Streamable HTTP MCP 客户端连接。 */
async function connectClient(mcpBase: string, token: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(`${mcpBase}${MCP_HTTP_PATH}`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: "memory-skills-remote-test", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

/** 从事件流里取全部授权拒绝事件（含限流拒绝）。 */
function deniedEvents(events: ObservabilityEvent[]): AuditDeniedEvent[] {
  return events.filter((event): event is AuditDeniedEvent => event.eventType === "audit.denied");
}

test("远程 MCP：未认证请求 401 并带 WWW-Authenticate 挑战", async () => {
  const stack = await startStack();
  try {
    const response = await fetch(`${stack.mcpBase}${MCP_HTTP_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    assert.equal(response.status, 401);
    assert.match(response.headers.get("www-authenticate") ?? "", /^Bearer/);
    const body = await response.json() as { error?: string };
    assert.equal(body.error, "UNAUTHORIZED");
  } finally {
    await stack.close();
  }
});

test("远程 MCP：无效 Token 401 且写入 audit.denied 审计事件", async () => {
  const stack = await startStack();
  try {
    const response = await fetch(`${stack.mcpBase}${MCP_HTTP_PATH}`, {
      method: "POST",
      headers: { authorization: "Bearer wrong-token", "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    assert.equal(response.status, 401);
    const denied = deniedEvents(stack.events).at(-1);
    assert.ok(denied, "应产生 audit.denied 事件");
    assert.equal(denied.path, "/mcp");
    assert.equal(denied.code, "UNAUTHORIZED");
  } finally {
    await stack.close();
  }
});

test("远程 MCP：reader Token 列出与单一目录一致的 4 个只读工具", async () => {
  const stack = await startStack();
  const client = await connectClient(stack.mcpBase, READER_TOKEN);
  try {
    const listed = await client.listTools();
    assert.deepEqual(
      listed.tools.map((tool) => tool.name).sort(),
      ["get_skill", "recall_context", "recall_memory", "search_skills"],
    );
    assert.ok(listed.tools.every((tool) => tool.annotations?.readOnlyHint === true));
  } finally {
    await client.close().catch(() => {});
    await stack.close();
  }
});

test("远程 MCP：recall_context 契约一致且作用域跟随认证主体", async () => {
  const stack = await startStack();
  // 团队 reader Token：召回 bob@acme 作用域，命中预置资产
  const bob = await connectClient(stack.mcpBase, READER_TOKEN);
  // 本地 Access Key：local-admin/local 作用域，无该资产
  const admin = await connectClient(stack.mcpBase, ACCESS_KEY);
  try {
    const bobResult = await bob.callTool({ name: "recall_context", arguments: { query: BOB_QUERY } });
    assert.equal(bobResult.isError, undefined);
    const bobEnvelope = JSON.parse((bobResult.content.find((block) => block.type === "text") as { text: string }).text);
    assert.equal(bobEnvelope.contractVersion, CONTRACT_VERSION);
    assert.deepEqual(bobEnvelope.scope, BOB_SCOPE);
    assert.equal(bobEnvelope.memories[0]?.id, "bob-mem-1");
    assert.deepEqual(bobResult.structuredContent, bobEnvelope);

    const adminResult = await admin.callTool({ name: "recall_context", arguments: { query: BOB_QUERY } });
    assert.equal(adminResult.isError, undefined);
    const adminEnvelope = JSON.parse((adminResult.content.find((block) => block.type === "text") as { text: string }).text);
    assert.equal(adminEnvelope.scope.userId, "local-admin");
    assert.equal(adminEnvelope.scope.teamId, "local");
    assert.equal(adminEnvelope.memories.length, 0);
  } finally {
    await bob.close().catch(() => {});
    await admin.close().catch(() => {});
    await stack.close();
  }
});

test("远程 MCP：read 域限流超限返回 429 与 Retry-After", async () => {
  const limiter = new RateLimiter({
    ...DEFAULT_RATE_LIMIT_RULES,
    read: { limit: 2, windowMs: 60_000 },
  });
  const stack = await startStack({ rateLimiter: limiter });
  try {
    const send = () => fetch(`${stack.mcpBase}${MCP_HTTP_PATH}`, {
      method: "POST",
      headers: { authorization: `Bearer ${ACCESS_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    const first = await send();
    const second = await send();
    const third = await send();
    assert.notEqual(first.status, 429);
    assert.notEqual(second.status, 429);
    assert.equal(third.status, 429);
    assert.ok(Number(third.headers.get("retry-after")) > 0);
    assert.ok(deniedEvents(stack.events).some((event) => event.code === "RATE_LIMITED"), "限流拒绝应写审计事件");
  } finally {
    await stack.close();
  }
});

test("远程 MCP：请求体超过 1MB 被拒（413）", async () => {
  const stack = await startStack();
  try {
    const response = await fetch(`${stack.mcpBase}${MCP_HTTP_PATH}`, {
      method: "POST",
      headers: { authorization: `Bearer ${ACCESS_KEY}`, "content-type": "application/json" },
      body: "x".repeat(1_000_001),
    });
    assert.equal(response.status, 413);
    const body = await response.json() as { error?: string };
    assert.equal(body.error, "PAYLOAD_TOO_LARGE");
  } finally {
    await stack.close();
  }
});

test("远程 MCP：GET/DELETE 会话操作在无状态模式下 405，PUT 一律 405", async () => {
  const stack = await startStack();
  try {
    const get = await fetch(`${stack.mcpBase}${MCP_HTTP_PATH}`, {
      method: "GET",
      headers: { authorization: `Bearer ${ACCESS_KEY}` },
    });
    assert.equal(get.status, 405, "无状态模式不提供 GET 会话流");
    const del = await fetch(`${stack.mcpBase}${MCP_HTTP_PATH}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${ACCESS_KEY}` },
    });
    assert.equal(del.status, 405);
    const put = await fetch(`${stack.mcpBase}${MCP_HTTP_PATH}`, {
      method: "PUT",
      headers: { authorization: `Bearer ${ACCESS_KEY}` },
    });
    assert.equal(put.status, 405);
    assert.match(put.headers.get("allow") ?? "", /POST/);
  } finally {
    await stack.close();
  }
});

test("远程 MCP：/health 无需认证且不泄漏配置", async () => {
  const stack = await startStack();
  try {
    const response = await fetch(`${stack.mcpBase}/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
  } finally {
    await stack.close();
  }
});

test("远程 MCP：配置 Host 允许列表后，不在列表内的 Host 被拒（403）", async () => {
  // undici 的 fetch 遵循禁止头名单、不允许伪造 Host 头，因此本用例验证的是
  // 允许列表的强制力：列表只放行 allowed.example，实际回环 Host 即被拒
  const stack = await startStack({ allowedHosts: ["allowed.example"] });
  try {
    const response = await fetch(`${stack.mcpBase}${MCP_HTTP_PATH}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${ACCESS_KEY}`,
        "content-type": "application/json",
        host: "evil.example",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    assert.equal(response.status, 403);
    const body = await response.json() as { error?: { message?: string } };
    assert.match(body.error?.message ?? "", /Invalid Host/);
  } finally {
    await stack.close();
  }
});
