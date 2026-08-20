import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { createMemorySkillsServer } from "./api/http-server.js";
import { SqliteRepository } from "./storage/sqlite-repository.js";
import { resolveEventSinkFromEnv } from "./observability/jsonl-event-sink.js";
import { EVENT_SCHEMA_VERSION } from "./observability/events.js";

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
// Access Key 作为禁止值注入事件输出：任何事件序列化结果命中它都会被脱敏
const eventSink = resolveEventSinkFromEnv(process.env, { forbiddenValues: [accessKey] });
const server = createMemorySkillsServer({ repository, accessKey, webRoot, eventSink });

server.listen(port, host, () => {
  eventSink.emit({
    schemaVersion: EVENT_SCHEMA_VERSION,
    eventType: "service.started",
    timestamp: new Date().toISOString(),
    host,
    port,
    databasePath,
  });
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
