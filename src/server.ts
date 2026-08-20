import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { createMemorySkillsServer } from "./api/http-server.js";
import { SqliteRepository } from "./storage/sqlite-repository.js";

const host = process.env.MEMORY_SKILLS_HOST ?? "127.0.0.1";
const port = Number.parseInt(process.env.MEMORY_SKILLS_PORT ?? "8421", 10);
const databasePath = resolve(process.env.MEMORY_SKILLS_DB ?? "data/memory-skills.db");
const webRoot = resolve(process.env.MEMORY_SKILLS_WEB_ROOT ?? "web/dist");
const accessKey = process.env.MEMORY_SKILLS_ACCESS_KEY;

if (!accessKey?.trim()) {
  throw new Error("MEMORY_SKILLS_ACCESS_KEY is required");
}

mkdirSync(dirname(databasePath), { recursive: true });
const repository = new SqliteRepository(databasePath);
const server = createMemorySkillsServer({ repository, accessKey, webRoot });

server.listen(port, host, () => {
  console.log(`memory-skills listening at http://${host}:${port}`);
});

function shutdown(): void {
  server.close(() => {
    repository.close();
    process.exit(0);
  });
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
