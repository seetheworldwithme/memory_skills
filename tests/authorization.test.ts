import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import test from "node:test";

import { createMemorySkillsServer } from "../src/api/http-server.js";
import { SqliteRepository } from "../src/storage/sqlite-repository.js";
import { AuthService, loadTeamTokensFile } from "../src/auth/auth-service.js";
import { sha256Hex } from "../src/auth/access-key.js";
import { MemorySkillsHttpClient } from "../src/adapters/mcp/http-client.js";

const LOCAL_KEY = "local-admin-key";
const READER_TOKEN = "team-reader-token";
const REVIEWER_TOKEN = "team-reviewer-token";
const REVOKED_TOKEN = "team-revoked-token";

/** 测试身份布局：bob=reader（仅自身）、carol=reviewer（租户级）、dave=已撤销 reader。 */
const auth = new AuthService({
  accessKey: LOCAL_KEY,
  teamTokens: [
    {
      id: "reader-bob",
      tokenHash: sha256Hex(READER_TOKEN),
      userId: "bob",
      teamId: "team-a",
      roles: ["reader"],
      userIds: ["bob"],
      agentIds: ["default"],
    },
    {
      id: "reviewer-carol",
      tokenHash: sha256Hex(REVIEWER_TOKEN),
      userId: "carol",
      teamId: "team-a",
      roles: ["reviewer"],
      userIds: "*",
    },
    {
      id: "revoked-dave",
      tokenHash: sha256Hex(REVOKED_TOKEN),
      userId: "dave",
      teamId: "team-a",
      roles: ["reader"],
      revoked: true,
    },
  ],
});

const bobScope = { userId: "bob", teamId: "team-a", agentId: "default" };
const carolScope = { userId: "carol", teamId: "team-a", agentId: "default" };

/** 启动带团队 Token 的测试服务，并预置 bob（verified+draft 记忆、verified Skill）与 carol 的资产。 */
async function startAuthorizationServer() {
  const repository = new SqliteRepository(":memory:");
  const server = createMemorySkillsServer({ repository, accessKey: LOCAL_KEY, authService: auth });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const close = async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    repository.close();
  };

  try {
    // 用本地 admin 预置资产：作用域与身份边界解耦，资产属于谁只看 scope
    await request(base, "POST", "/v1/evidence", {
      id: "authz-ev-bob", scope: bobScope, role: "user", content: "bob 偏好中文回复",
    }, LOCAL_KEY);
    await request(base, "POST", "/v1/memories", {
      id: "authz-mem-verified", layer: "l1", scope: bobScope,
      content: "bob 偏好中文回复", confidence: 0.9, reason: "explicit instruction",
      sourceEvidenceIds: ["authz-ev-bob"],
    }, LOCAL_KEY);
    await request(base, "POST", "/v1/memories/authz-mem-verified/status", { scope: bobScope, target: "verified" }, LOCAL_KEY);
    await request(base, "POST", "/v1/memories", {
      id: "authz-mem-draft", layer: "l1", scope: bobScope,
      content: "bob 在写一本书（草稿）", confidence: 0.6, reason: "draft candidate",
      sourceEvidenceIds: ["authz-ev-bob"],
    }, LOCAL_KEY);
    await request(base, "POST", "/v1/skills", {
      id: "authz-skill", scope: bobScope, name: "deploy-service",
      description: "按清单部署服务",
      content: "---\nname: deploy-service\ndescription: 按清单部署服务\n---\n\n## When to use\n\n部署时。\n\n## Workflow\n\n1. 构建镜像\n\n## Verification\n\n看健康检查。\n\n## Failure handling\n\n回滚。",
      sourceEvidenceIds: ["authz-ev-bob"],
    }, LOCAL_KEY);
    await request(base, "POST", "/v1/skills/authz-skill/status", { scope: bobScope, target: "verified" }, LOCAL_KEY);
    await request(base, "POST", "/v1/evidence", {
      id: "authz-ev-carol", scope: carolScope, role: "user", content: "carol 的证据",
    }, LOCAL_KEY);
    await request(base, "POST", "/v1/memories", {
      id: "authz-mem-carol", layer: "l1", scope: carolScope,
      content: "carol 的私有记忆", confidence: 0.9, reason: "explicit instruction",
      sourceEvidenceIds: ["authz-ev-carol"],
    }, LOCAL_KEY);
    await request(base, "POST", "/v1/memories/authz-mem-carol/status", { scope: carolScope, target: "verified" }, LOCAL_KEY);
  } catch (error) {
    // 预置失败先关服务再抛出，避免遗留监听进程挂起测试运行器
    await close();
    throw error;
  }

  return { base, close };
}

test("本地 Access Key 是全边界 admin：写/审/读与任意作用域全部通过（兼容回归）", async () => {
  const { base, close } = await startAuthorizationServer();
  try {
    // 写：任意作用域（包括环境变量之外的租户）都能捕获
    const evidence = await request(base, "POST", "/v1/evidence", {
      id: "authz-ev-any", scope: { userId: "zoe", teamId: "team-z", agentId: "default" },
      role: "user", content: "任意作用域",
    }, LOCAL_KEY);
    assert.equal(evidence.id, "authz-ev-any");

    // 审核：跨租户状态转换
    const transitioned = await request(base, "POST", "/v1/memories/authz-mem-verified/status", { scope: bobScope, target: "deprecated" }, LOCAL_KEY);
    assert.equal(transitioned.governance.status, "deprecated");
    await request(base, "POST", "/v1/memories/authz-mem-verified/status", { scope: bobScope, target: "verified" }, LOCAL_KEY);

    // 读 + Draft 可见（admin 具备 review 动作）
    const recall = await request(base, "POST", "/v1/recall", { query: "偏好", scope: bobScope, includeDraft: true }, LOCAL_KEY);
    assert.ok(recall.items.length >= 1);
  } finally {
    await close();
  }
});

test("动作矩阵：reader 只读、reviewer 读+审核，写端点一律 403 FORBIDDEN_ACTION", async () => {
  const { base, close } = await startAuthorizationServer();
  try {
    // reader：读端点通过
    const listed = await request(base, "POST", "/v1/memories/list", { scope: bobScope }, READER_TOKEN);
    assert.ok(Array.isArray(listed.items));

    // reader：写端点（捕获证据、创建 Draft）拒绝
    const writeEvidence = await rawRequest(base, "POST", "/v1/evidence", {
      id: "authz-ev-forbidden", scope: bobScope, role: "user", content: "x",
    }, READER_TOKEN);
    assert.equal(writeEvidence.status, 403);
    assert.equal((await writeEvidence.json()).error, "FORBIDDEN_ACTION");

    const writeMemory = await rawRequest(base, "POST", "/v1/memories", {
      id: "authz-mem-forbidden", layer: "l1", scope: bobScope,
      content: "x", confidence: 0.9, reason: "x", sourceEvidenceIds: ["authz-ev-bob"],
    }, READER_TOKEN);
    assert.equal(writeMemory.status, 403);

    const writeProposal = await rawRequest(base, "POST", "/v1/proposals/memory/run", {
      scope: bobScope, evidenceIds: ["authz-ev-bob"],
    }, READER_TOKEN);
    assert.ok(writeProposal.status === 403, "提案是写动作，reader 应被拒绝");

    // reader：审核端点（状态转换、回滚、反馈清单、治理工作台）拒绝
    const transition = await rawRequest(base, "POST", "/v1/memories/authz-mem-draft/status", { scope: bobScope, target: "verified" }, READER_TOKEN);
    assert.equal(transition.status, 403);
    assert.equal((await transition.json()).error, "FORBIDDEN_ACTION");

    const rollback = await rawRequest(base, "POST", "/v1/skills/authz-skill/rollback", { scope: bobScope, targetVersion: 1 }, READER_TOKEN);
    assert.equal(rollback.status, 403);

    const feedbackList = await rawRequest(base, "POST", "/v1/feedback/list", { scope: bobScope }, READER_TOKEN);
    assert.equal(feedbackList.status, 403);

    const conflicts = await rawRequest(base, "POST", "/v1/governance/conflicts", { scope: bobScope }, READER_TOKEN);
    assert.equal(conflicts.status, 403);

    // reviewer：租户级边界内可审核他人资产，但写仍拒绝
    const reviewTransition = await request(base, "POST", "/v1/memories/authz-mem-draft/status", { scope: bobScope, target: "verified" }, REVIEWER_TOKEN);
    assert.equal(reviewTransition.governance.status, "verified");

    const reviewWrite = await rawRequest(base, "POST", "/v1/evidence", {
      id: "authz-ev-reviewer", scope: carolScope, role: "user", content: "x",
    }, REVIEWER_TOKEN);
    assert.equal(reviewWrite.status, 403);

    // reader 可提交显式反馈与 Skill 使用记录（采集不改变资产状态，与读同级）
    const feedback = await request(base, "POST", "/v1/feedback", {
      assetKind: "memory", assetId: "authz-mem-verified", scope: bobScope, kind: "useful",
    }, READER_TOKEN);
    assert.equal(feedback.kind, "useful");

    const run = await request(base, "POST", "/v1/skills/authz-skill/runs", {
      scope: bobScope, event: "recalled",
    }, READER_TOKEN);
    assert.equal(run.event, "recalled");
  } finally {
    await close();
  }
});

test("作用域边界：跨租户与同租户越界一律 403 FORBIDDEN_SCOPE", async () => {
  const { base, close } = await startAuthorizationServer();
  try {
    // 跨租户：team-a Token 请求 team-b 作用域
    const crossTeam = await rawRequest(base, "POST", "/v1/memories/list", {
      scope: { userId: "bob", teamId: "team-b", agentId: "default" },
    }, READER_TOKEN);
    assert.equal(crossTeam.status, 403);
    assert.equal((await crossTeam.json()).error, "FORBIDDEN_SCOPE");

    // 同租户但 userId 越界：bob 的 Token 请求 carol 的作用域
    const crossUser = await rawRequest(base, "POST", "/v1/memories/list", { scope: carolScope }, READER_TOKEN);
    assert.equal(crossUser.status, 403);
    assert.equal((await crossUser.json()).error, "FORBIDDEN_SCOPE");

    // agentId 维度同样生效
    const crossAgent = await rawRequest(base, "POST", "/v1/memories/list", {
      scope: { userId: "bob", teamId: "team-a", agentId: "other-agent" },
    }, READER_TOKEN);
    assert.equal(crossAgent.status, 403);

    // reviewer 的租户级边界（userIds="*"）可以读全租户
    const reviewerList = await request(base, "POST", "/v1/memories/list", { scope: bobScope }, REVIEWER_TOKEN);
    assert.ok(Array.isArray(reviewerList.items));
  } finally {
    await close();
  }
});

test("ID 猜测不泄漏：边界内作用域请求其他作用域的资产返回 404", async () => {
  const { base, close } = await startAuthorizationServer();
  try {
    // carol 的资产确实存在，但 bob 用自己的作用域查询只能得到 404，得不到内容或存在性
    const guess = await rawRequest(base, "POST", "/v1/memories/get", { id: "authz-mem-carol", scope: bobScope }, READER_TOKEN);
    assert.equal(guess.status, 404);
    assert.equal((await guess.json()).error, "NOT_FOUND");

    // 直接用 carol 作用域查询（越界 scope）被 403 拦截，先于任何数据访问
    const stolen = await rawRequest(base, "POST", "/v1/memories/get", { id: "authz-mem-carol", scope: carolScope }, READER_TOKEN);
    assert.equal(stolen.status, 403);

    // 边界内不存在的 ID 同样 404，与真实资产不可区分
    const missing = await rawRequest(base, "POST", "/v1/memories/get", { id: "authz-mem-nope", scope: bobScope }, READER_TOKEN);
    assert.equal(missing.status, 404);
  } finally {
    await close();
  }
});

test("Draft 可见性属于审核能力：reader 请求 includeDraft 被拒绝，reviewer 可见", async () => {
  const { base, close } = await startAuthorizationServer();
  try {
    const readerDraft = await rawRequest(base, "POST", "/v1/recall", {
      query: "草稿", scope: bobScope, includeDraft: true,
    }, READER_TOKEN);
    assert.equal(readerDraft.status, 403);
    assert.equal((await readerDraft.json()).error, "FORBIDDEN_ACTION");

    const readerSkillDraft = await rawRequest(base, "POST", "/v1/skills/search", {
      query: "deploy", scope: bobScope, includeDraft: true,
    }, READER_TOKEN);
    assert.equal(readerSkillDraft.status, 403);

    const readerContextDraft = await rawRequest(base, "POST", "/v1/context/recall", {
      query: "草稿", scope: bobScope, includeDraft: true,
    }, READER_TOKEN);
    assert.equal(readerContextDraft.status, 403);

    // reader 默认召回只含 Verified，Draft 永不出现
    const readerDefault = await request(base, "POST", "/v1/recall", { query: "草稿", scope: bobScope }, READER_TOKEN);
    assert.ok(readerDefault.items.every((item: { governance?: { status?: string } }) => item.governance?.status !== "draft"));

    // reviewer 可以看到 Draft（审核工作台对照来源）
    const reviewerDraft = await request(base, "POST", "/v1/recall", {
      query: "草稿", scope: bobScope, includeDraft: true,
    }, REVIEWER_TOKEN);
    assert.ok(reviewerDraft.items.some((item: { id: string; governance?: { status?: string } }) =>
      item.id === "authz-mem-draft" && item.governance?.status === "draft"));
  } finally {
    await close();
  }
});

test("提权与认证失败：请求体自报角色被忽略，无效或已撤销 Token 一律 401", async () => {
  const { base, close } = await startAuthorizationServer();
  try {
    // 请求体携带 roles/principal 字段试图自报身份：授权只认认证结果，仍被拒绝
    const escalation = await rawRequest(base, "POST", "/v1/memories", {
      id: "authz-mem-escalate", layer: "l1", scope: bobScope,
      content: "x", confidence: 0.9, reason: "x", sourceEvidenceIds: ["authz-ev-bob"],
      roles: ["admin"], principal: { userId: "local-admin", roles: ["admin"] },
    }, READER_TOKEN);
    assert.equal(escalation.status, 403);
    assert.equal((await escalation.json()).error, "FORBIDDEN_ACTION");

    // 已撤销 Token 与未知 Token 都无法认证，也不区分失败原因
    const revoked = await rawRequest(base, "POST", "/v1/memories/list", { scope: bobScope }, REVOKED_TOKEN);
    assert.equal(revoked.status, 401);

    const unknown = await rawRequest(base, "POST", "/v1/memories/list", { scope: bobScope }, "not-a-token");
    assert.equal(unknown.status, 401);

    const noHeader = await rawRequest(base, "POST", "/v1/memories/list", { scope: bobScope }, null);
    assert.equal(noHeader.status, 401);
  } finally {
    await close();
  }
});

test("login 换取认证身份：本地 Key 是 admin，团队 Token 返回各自角色与边界", async () => {
  const { base, close } = await startAuthorizationServer();
  try {
    // login 是公开端点，凭据在请求体内，不需要 Bearer Token
    const local = await request(base, "POST", "/v1/auth/login", { accessKey: LOCAL_KEY }, null);
    assert.equal(local.authenticated, true);
    assert.equal(local.user.id, "local-admin");
    assert.deepEqual(local.principal.roles, ["admin"]);
    assert.equal(local.principal.boundary.userIds, "*");

    const reader = await request(base, "POST", "/v1/auth/login", { accessKey: READER_TOKEN }, null);
    assert.deepEqual(reader.principal.roles, ["reader"]);
    assert.equal(reader.principal.source, "team-token");
    assert.deepEqual(reader.principal.boundary.userIds, ["bob"]);

    const invalid = await rawRequest(base, "POST", "/v1/auth/login", { accessKey: "wrong" }, null);
    assert.equal(invalid.status, 401);
  } finally {
    await close();
  }
});

test("团队 Token 配置文件：合法加载、维度通配、损坏文件拒绝启动", async () => {
  const dir = await mkdtemp(join(tmpdir(), "memory-skills-auth-"));
  try {
    const validPath = join(dir, "tokens.json");
    await writeFile(validPath, JSON.stringify({
      version: 1,
      tokens: [
        {
          id: "agent-reader",
          tokenHash: sha256Hex("file-token-1"),
          userId: "agent",
          teamId: "team-a",
          roles: ["reader"],
          userIds: "*",
          agentIds: ["default"],
          createdAt: "2026-08-21T00:00:00.000Z",
        },
      ],
    }), "utf8");
    const records = await loadTeamTokensFile(validPath);
    assert.equal(records.length, 1);
    assert.equal(records[0]!.userIds, "*");
    assert.deepEqual(records[0]!.agentIds, ["default"]);

    // 文件 Token 可完成认证并映射到 reader Principal
    const service = new AuthService({ accessKey: LOCAL_KEY, teamTokens: records });
    const principal = service.authenticate("file-token-1");
    assert.deepEqual(principal?.roles, ["reader"]);
    assert.equal(principal?.boundary.teamIds[0], "team-a");

    // 坏 JSON、未知角色、非法哈希都抛错：安全配置问题绝不静默降级
    const badJsonPath = join(dir, "bad-json.json");
    await writeFile(badJsonPath, "{not json", "utf8");
    await assert.rejects(() => loadTeamTokensFile(badJsonPath), /不是合法 JSON/);

    const badRolePath = join(dir, "bad-role.json");
    await writeFile(badRolePath, JSON.stringify({
      version: 1,
      tokens: [{ id: "x", tokenHash: sha256Hex("t"), userId: "u", teamId: "team-a", roles: ["root"] }],
    }), "utf8");
    await assert.rejects(() => loadTeamTokensFile(badRolePath), /未知角色/);

    const badHashPath = join(dir, "bad-hash.json");
    await writeFile(badHashPath, JSON.stringify({
      version: 1,
      tokens: [{ id: "x", tokenHash: "plaintext", userId: "u", teamId: "team-a", roles: ["reader"] }],
    }), "utf8");
    await assert.rejects(() => loadTeamTokensFile(badHashPath), /sha256 hex/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("MCP HTTP 客户端优先使用 MEMORY_SKILLS_AUTH_TOKEN（团队只读 Token）", () => {
  const client = MemorySkillsHttpClient.fromEnv({
    MEMORY_SKILLS_URL: "http://127.0.0.1:8421",
    MEMORY_SKILLS_AUTH_TOKEN: "reader-token",
    MEMORY_SKILLS_ACCESS_KEY: "local-admin-key",
  });
  assert.equal((client as unknown as { accessKey: string }).accessKey, "reader-token");

  const fallback = MemorySkillsHttpClient.fromEnv({
    MEMORY_SKILLS_URL: "http://127.0.0.1:8421",
    MEMORY_SKILLS_ACCESS_KEY: "local-admin-key",
  });
  assert.equal((fallback as unknown as { accessKey: string }).accessKey, "local-admin-key");

  assert.throws(() => MemorySkillsHttpClient.fromEnv({ MEMORY_SKILLS_URL: "http://127.0.0.1:8421" }), /MEMORY_SKILLS_AUTH_TOKEN/);
});

async function rawRequest(
  base: string,
  method: string,
  path: string,
  body: unknown,
  token: string | null,
): Promise<Response> {
  return fetch(`${base}${path}`, {
    method,
    headers: {
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

async function request(base: string, method: string, path: string, body: unknown, token: string | null): Promise<any> {
  const response = await rawRequest(base, method, path, body, token);
  const text = await response.text();
  const parsed = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(`${method} ${path} -> ${response.status}: ${text}`);
  }
  return parsed;
}
