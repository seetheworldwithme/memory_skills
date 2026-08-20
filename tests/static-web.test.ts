import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createMemorySkillsServer } from "../src/api/http-server.js";
import { SqliteRepository } from "../src/storage/sqlite-repository.js";

test("serves the web console and falls back to its index", async () => {
  const webRoot = mkdtempSync(join(tmpdir(), "memory-skills-web-"));
  writeFileSync(join(webRoot, "index.html"), "<!doctype html><title>Memory Skills UI</title>");
  writeFileSync(join(webRoot, "app.js"), "console.log('memory-skills')");
  const repository = new SqliteRepository(":memory:");
  const server = createMemorySkillsServer({ repository, accessKey: "test-key", webRoot });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;

  try {
    const root = await fetch(base);
    assert.equal(root.status, 200);
    assert.match(await root.text(), /Memory Skills UI/);
    assert.match(root.headers.get("content-type") ?? "", /text\/html/);

    const asset = await fetch(`${base}/app.js`);
    assert.equal(asset.status, 200);
    assert.match(asset.headers.get("content-type") ?? "", /javascript/);

    const fallback = await fetch(`${base}/memory`);
    assert.equal(fallback.status, 200);
    assert.match(await fallback.text(), /Memory Skills UI/);

    const missingApi = await fetch(`${base}/v1/missing`, {
      headers: { authorization: "Bearer test-key" },
    });
    assert.equal(missingApi.status, 404);
    assert.match(missingApi.headers.get("content-type") ?? "", /application\/json/);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    repository.close();
    rmSync(webRoot, { recursive: true });
  }
});
