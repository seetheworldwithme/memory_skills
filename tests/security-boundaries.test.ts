import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";

import { createMemorySkillsServer } from "../src/api/http-server.js";
import { SqliteRepository } from "../src/storage/sqlite-repository.js";
import { AuthService } from "../src/auth/auth-service.js";
import { sha256Hex } from "../src/auth/access-key.js";
import { AuditService } from "../src/security/audit-service.js";
import { RateLimiter, resolveRateLimitRulesFromEnv, type RateLimitRules } from "../src/security/rate-limit.js";
import { redactJson, redactText, REDACTED } from "../src/security/redaction.js";
import type { EventSink, } from "../src/observability/event-sink.js";
import { serializeObservabilityEvent, type ObservabilityEvent } from "../src/observability/events.js";

const LOCAL_KEY = "security-admin-key";
const READER_TOKEN = "security-reader-token";

/** 记录事件用内存 Sink：测试直接断言审计事件内容。 */
class RecordingSink implements EventSink {
  readonly events: ObservabilityEvent[] = [];
  emit(event: ObservabilityEvent): void {
    this.events.push(event);
  }
}

const scope = { userId: "alice", teamId: "team-a", agentId: "agent-a" };

/** 启动带限流与审计的测试服务；限流阈值小到几次请求即可触发。 */
async function startSecurityServer(rules: RateLimitRules) {
  const repository = new SqliteRepository(":memory:");
  const sink = new RecordingSink();
  const auth = new AuthService({
    accessKey: LOCAL_KEY,
    teamTokens: [{
      id: "reader", tokenHash: sha256Hex(READER_TOKEN),
      userId: "bob", teamId: "team-a", roles: ["reader"], userIds: ["bob"],
    }],
  });
  const server = createMemorySkillsServer({
    repository,
    accessKey: LOCAL_KEY,
    authService: auth,
    security: { rateLimiter: new RateLimiter(rules), audit: new AuditService(sink) },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    sink,
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: async () => {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      repository.close();
    },
  };
}

test("登录失败限流：限速防爆破——正确登录不受失败计数影响，失败超阈值被拒", async () => {
  const { base, sink, close } = await startSecurityServer({
    login: { limit: 20, windowMs: 60_000 },
    loginFailure: { limit: 3, windowMs: 60_000 },
    write: { limit: 50, windowMs: 60_000 },
    read: { limit: 50, windowMs: 60_000 },
  });
  try {
    for (let i = 0; i < 3; i += 1) {
      const failed = await post(base, "/v1/auth/login", { accessKey: `wrong-${i}` }, null);
      assert.equal(failed.status, 401);
    }
    // 正确凭据不受失败计数影响（限速而非锁死，攻击者无法制造失败拒真用户）
    const legitimate = await post(base, "/v1/auth/login", { accessKey: LOCAL_KEY }, null);
    assert.equal(legitimate.status, 200);
    // 失败配额已耗尽：继续爆破被 429 拒绝
    const locked = await post(base, "/v1/auth/login", { accessKey: "wrong-again" }, null);
    assert.equal(locked.status, 429);
    assert.equal((await locked.json()).error, "RATE_LIMITED");
    assert.ok(Number(locked.headers.get("retry-after")) >= 1);

    // 每次失败都有审计事件：3 条凭据错误 + 1 条限流拒绝，均不含提交的凭据值
    const loginAudits = sink.events.filter((event) => event.eventType === "audit.login_failed");
    assert.equal(loginAudits.length, 4);
    const serialized = loginAudits.map((event) => serializeObservabilityEvent(event)).join("\n");
    assert.ok(!serialized.includes(LOCAL_KEY));
    assert.ok(!serialized.includes("wrong-"));
  } finally {
    await close();
  }
});

test("写域限流：高价值操作超限返回 429，读域互不影响", async () => {
  const { base, close } = await startSecurityServer({
    login: { limit: 20, windowMs: 60_000 },
    loginFailure: { limit: 10, windowMs: 60_000 },
    write: { limit: 2, windowMs: 60_000 },
    read: { limit: 50, windowMs: 60_000 },
  });
  try {
    for (let i = 0; i < 2; i += 1) {
      const created = await post(base, "/v1/evidence", {
        id: `sec-ev-${i}`, scope, role: "user", content: `内容 ${i}`,
      }, LOCAL_KEY);
      assert.equal(created.status, 200);
    }
    const limited = await post(base, "/v1/evidence", {
      id: "sec-ev-2", scope, role: "user", content: "第三次",
    }, LOCAL_KEY);
    assert.equal(limited.status, 429);
    assert.equal((await limited.json()).error, "RATE_LIMITED");

    // 读域配额独立：查询不受写限流影响
    const listed = await post(base, "/v1/memories/list", { scope }, LOCAL_KEY);
    assert.equal(listed.status, 200);

    // 未认证请求先被 401 拦截，不消耗限流配额
    const anonymous = await post(base, "/v1/evidence", { id: "x", scope, role: "user", content: "y" }, null);
    assert.equal(anonymous.status, 401);
  } finally {
    await close();
  }
});

test("读域限流：查询超限返回 429", async () => {
  const { base, close } = await startSecurityServer({
    login: { limit: 20, windowMs: 60_000 },
    loginFailure: { limit: 10, windowMs: 60_000 },
    write: { limit: 50, windowMs: 60_000 },
    read: { limit: 2, windowMs: 60_000 },
  });
  try {
    assert.equal((await post(base, "/v1/memories/list", { scope }, LOCAL_KEY)).status, 200);
    assert.equal((await post(base, "/v1/memories/list", { scope }, LOCAL_KEY)).status, 200);
    const limited = await post(base, "/v1/memories/list", { scope }, LOCAL_KEY);
    assert.equal(limited.status, 429);
  } finally {
    await close();
  }
});

test("审计事件：授权拒绝与状态变更被完整记录，且不含资产正文或密钥", async () => {
  const { base, sink, close } = await startSecurityServer({
    login: { limit: 20, windowMs: 60_000 },
    loginFailure: { limit: 10, windowMs: 60_000 },
    write: { limit: 50, windowMs: 60_000 },
    read: { limit: 50, windowMs: 60_000 },
  });
  try {
    // 401：匿名拒绝
    await post(base, "/v1/memories/list", { scope }, null);
    // 403：reader 越权写
    await post(base, "/v1/evidence", {
      id: "sec-ev-x", scope: { userId: "bob", teamId: "team-a", agentId: "default" },
      role: "user", content: "越权内容",
    }, READER_TOKEN);
    // 状态变更：draft -> verified
    await post(base, "/v1/evidence", { id: "sec-ev-1", scope, role: "user", content: "证据原文" }, LOCAL_KEY);
    await post(base, "/v1/memories", {
      id: "sec-mem-1", layer: "l1", scope, content: "机密级记忆正文不该进审计",
      confidence: 0.9, reason: "test", sourceEvidenceIds: ["sec-ev-1"],
    }, LOCAL_KEY);
    await post(base, "/v1/memories/sec-mem-1/status", { scope, target: "verified" }, LOCAL_KEY);

    const denied = sink.events.filter((event) => event.eventType === "audit.denied");
    assert.equal(denied.length, 2);
    assert.equal(denied[0]!.userId, "anonymous");
    assert.equal(denied[0]!.code, "UNAUTHORIZED");
    assert.equal(denied[1]!.userId, "bob");
    assert.equal(denied[1]!.code, "FORBIDDEN_ACTION");
    assert.equal(denied[1]!.action, "write");

    const changed = sink.events.filter((event) => event.eventType === "audit.state_changed");
    assert.equal(changed.length, 1);
    assert.equal(changed[0]!.from, "draft");
    assert.equal(changed[0]!.to, "verified");
    assert.equal(changed[0]!.trigger, "memory.transition");

    // 白名单投影的结构性保证：审计事件序列化后不含正文与密钥
    const all = sink.events.map((event) => serializeObservabilityEvent(event)).join("\n");
    assert.ok(!all.includes("机密级记忆正文"));
    assert.ok(!all.includes(LOCAL_KEY));
    assert.ok(!all.includes(READER_TOKEN));
  } finally {
    await close();
  }
});

test("超限请求体被拒绝：1MB 大小红线保持不变", async () => {
  const { base, close } = await startSecurityServer({
    login: { limit: 20, windowMs: 60_000 },
    loginFailure: { limit: 10, windowMs: 60_000 },
    write: { limit: 50, windowMs: 60_000 },
    read: { limit: 50, windowMs: 60_000 },
  });
  try {
    const oversized = await post(base, "/v1/evidence", {
      id: "big", scope, role: "user", content: "x".repeat(1_100_000),
    }, LOCAL_KEY);
    assert.equal(oversized.status, 400);
  } finally {
    await close();
  }
});

test("固定窗口限流器：窗口翻转后配额恢复（注入时钟，确定性验证）", () => {
  let now = 1_000_000;
  const limiter = new RateLimiter({
    login: { limit: 1, windowMs: 1_000 },
    loginFailure: { limit: 1, windowMs: 1_000 },
    write: { limit: 2, windowMs: 1_000 },
    read: { limit: 2, windowMs: 1_000 },
  }, () => now);

  assert.equal(limiter.consume("write", "alice").allowed, true);
  assert.equal(limiter.consume("write", "alice").allowed, true);
  assert.equal(limiter.consume("write", "alice").allowed, false);
  // 不同身份配额独立
  assert.equal(limiter.consume("write", "bob").allowed, true);
  // 窗口翻转：配额恢复
  now += 1_001;
  assert.equal(limiter.consume("write", "alice").allowed, true);
});

test("限流规则环境变量：可收紧，非法值拒绝启动", () => {
  const rules = resolveRateLimitRulesFromEnv({ MEMORY_SKILLS_RATE_LIMIT_WRITE_PER_MIN: "5" });
  assert.equal(rules.write.limit, 5);
  assert.equal(rules.read.limit, resolveRateLimitRulesFromEnv({}).read.limit);

  assert.throws(
    () => resolveRateLimitRulesFromEnv({ MEMORY_SKILLS_RATE_LIMIT_READ_PER_MIN: "0" }),
    /正整数/,
  );
});

test("输出侧脱敏：密钥模式与禁止值替换为 [REDACTED]，超长字段截断", () => {
  assert.equal(redactText("call sk-abcdef0123456789abcdef now"), `call ${REDACTED} now`);
  assert.equal(redactText("Authorization: Bearer abcdef0123456789abcdef01"), `Authorization: ${REDACTED}`);
  // 键值对整体替换（键名与值一并遮蔽，阅读时仍能认出"这里曾有密钥"）
  assert.equal(redactText("api_key = 0123456789abcdef"), REDACTED);
  assert.equal(redactText("token: 0123456789abcdefghijkl"), REDACTED);
  // 精确禁止值整体替换
  assert.equal(redactText("key=super-secret-value-42", { forbiddenValues: ["super-secret-value-42"] }), `key=${REDACTED}`);
  // 长十六进制 blob（如真实密钥）被替换
  assert.ok(!redactText("hash a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6").includes("a1b2c3d4"));
  // 超长截断
  const long = redactText("x".repeat(500), { maxFieldLength: 50 });
  assert.ok(long.startsWith("xxxx"));
  assert.ok(long.endsWith("[truncated]"));
  assert.ok(long.length < 100);

  // 深度脱敏：嵌套结构逐字段处理，非字符串原样保留
  const redacted = redactJson({
    note: "bearer abcdef0123456789abcdef01",
    nested: { key: "sk-abcdef0123456789abcdef" },
    count: 3,
    list: ["password: 0123456789abcdef"],
  }) as Record<string, unknown>;
  assert.equal((redacted.note as string).trim(), REDACTED);
  assert.equal((redacted.nested as { key: string }).key, REDACTED);
  assert.equal(redacted.count, 3);
  assert.ok(!(redacted.list as string[])[0]!.includes("0123456789"));
});

function post(base: string, path: string, body: unknown, token: string | null): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}
