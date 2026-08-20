import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { createMemorySkillsServer } from "./api/http-server.js";
import { SqliteRepository } from "./storage/sqlite-repository.js";
import { resolveEventSinkFromEnv } from "./observability/jsonl-event-sink.js";
import { EVENT_SCHEMA_VERSION } from "./observability/events.js";
import { InMemoryLlmMetricsRecorder } from "./llm/provider.js";
import { createLlmProvider } from "./llm/provider-registry.js";
import { resolveLlmConfigFromEnv } from "./llm/model-config.js";
import type { LlmProvider } from "./llm/types.js";
import { resolveRetrieverFromEnv } from "./retrieval/retriever.js";
import { describeEmbeddingConfig } from "./retrieval/embedding-provider.js";

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

// 组装 LLM Provider：初始化失败不阻断服务启动，仅提案 API 返回 503
let llmProvider: LlmProvider | undefined;
try {
  llmProvider = createLlmProvider(resolveLlmConfigFromEnv(process.env), {
    metrics: new InMemoryLlmMetricsRecorder(),
  });
} catch (error) {
  // 错误消息来自 LlmProviderError 的稳定模板，不含密钥
  console.error(`LLM Provider 初始化失败，提案功能不可用：${error instanceof Error ? error.message : String(error)}`);
}

// 组装检索层：默认词法；MEMORY_SKILLS_RETRIEVAL=hybrid 时启用向量通道。
// 初始化失败同样不阻断启动，召回自动保持词法路径
let retrieval: ReturnType<typeof resolveRetrieverFromEnv> | undefined;
try {
  retrieval = resolveRetrieverFromEnv(process.env, { vectorDatabasePath: databasePath });
  if (retrieval.embedding) {
    // 描述对象显式投影全部字段，证明不含密钥值
    console.log(`混合检索已启用：${JSON.stringify(describeEmbeddingConfig(retrieval.embedding.config))}`);
  }
} catch (error) {
  retrieval = undefined;
  console.error(`检索层初始化失败，保持词法检索：${error instanceof Error ? error.message : String(error)}`);
}

const server = createMemorySkillsServer({
  repository,
  accessKey,
  webRoot,
  eventSink,
  ...(llmProvider !== undefined ? { llmProvider } : {}),
  ...(retrieval !== undefined ? { retriever: retrieval.retriever } : {}),
  ...(retrieval?.embedding !== undefined
    ? { embedding: { provider: retrieval.embedding.provider, index: retrieval.embedding.index } }
    : {}),
});

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
