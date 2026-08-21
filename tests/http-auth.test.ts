import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";

import { createMemorySkillsServer } from "../src/api/http-server.js";
import { SqliteRepository } from "../src/storage/sqlite-repository.js";

test("access-key login protects domain APIs", async () => {
  const repository = new SqliteRepository(":memory:");
  const server = createMemorySkillsServer({ repository, accessKey: "test-secret-key" });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;

  try {
    const rejectedLogin = await fetch(`${base}/v1/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ accessKey: "wrong-key" }),
    });
    assert.equal(rejectedLogin.status, 401);

    const acceptedLogin = await fetch(`${base}/v1/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ accessKey: "test-secret-key" }),
    });
    assert.equal(acceptedLogin.status, 200);
    // Task 15：login 响应附带认证身份（角色与作用域边界），字段只来自认证结果
    const loginBody = await acceptedLogin.json() as {
      authenticated: boolean;
      user: { id: string; name: string };
      principal: { userId: string; teamId: string; roles: string[]; source: string };
    };
    assert.equal(loginBody.authenticated, true);
    assert.deepEqual(loginBody.user, { id: "local-admin", name: "Local Administrator" });
    assert.deepEqual(loginBody.principal, {
      userId: "local-admin",
      teamId: "local",
      roles: ["admin"],
      boundary: { teamIds: "*", userIds: "*", agentIds: "*" },
      source: "local-access-key",
    });

    const anonymous = await fetch(`${base}/v1/memories/list`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scope: { userId: "local-admin", teamId: "local", agentId: "default" } }),
    });
    assert.equal(anonymous.status, 401);
    assert.equal((await anonymous.json()).error, "UNAUTHORIZED");

    const authorized = await fetch(`${base}/v1/memories/list`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-secret-key",
        "content-type": "application/json",
      },
      body: JSON.stringify({ scope: { userId: "local-admin", teamId: "local", agentId: "default" } }),
    });
    assert.equal(authorized.status, 200);
    assert.deepEqual(await authorized.json(), { items: [] });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    repository.close();
  }
});
