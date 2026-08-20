import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";

import { accessKeyMatches, bearerToken } from "../auth/access-key.js";
import type { GovernedStatus } from "../governance/lifecycle.js";
import { MemoryService } from "../memory/memory-service.js";
import { SkillService, SkillVersionConflictError } from "../skills/skill-service.js";
import type { SqliteRepository } from "../storage/sqlite-repository.js";
import { DomainError } from "../errors.js";
import { GovernanceError } from "../governance/lifecycle.js";
import { ContextService } from "../context/context-service.js";
import { ProposalService } from "../extraction/proposal-service.js";
import type { ProposalJobInput } from "../extraction/interfaces.js";
import type { LlmProvider } from "../llm/types.js";
import type { EventSink } from "../observability/event-sink.js";
import { EVENT_SCHEMA_VERSION, errorCodeFor, type RetrievalAutoSyncCompletedEvent, type RetrievalAutoSyncFailedEvent } from "../observability/events.js";
import { EmbeddingSyncService } from "../retrieval/embedding-sync.js";
import type { AssetKind, EmbeddingProvider, Retriever, VectorIndex } from "../retrieval/types.js";
import type { Scope } from "../governance/types.js";
import { FeedbackService } from "../feedback/feedback-service.js";
import type { FeedbackAssetKind, FeedbackKind } from "../feedback/types.js";

export function createMemorySkillsServer(options: {
  repository: SqliteRepository;
  accessKey: string;
  webRoot?: string;
  eventSink?: EventSink;
  /** 模型 Provider：未注入时提案 API 返回 503，其余能力不受影响。 */
  llmProvider?: LlmProvider;
  /** 检索器：默认词法；注入 HybridRetriever 后 /v1/context/recall 走混合排序。 */
  retriever?: Retriever;
  /** 向量同步组件：注入后开放 /v1/retrieval/sync，缺省时该端点返回 503。 */
  embedding?: { provider: EmbeddingProvider; index: VectorIndex; batchSize?: number };
}): Server {
  if (!options.accessKey.trim()) throw new Error("accessKey must not be empty");
  const memory = new MemoryService(options.repository);
  const skills = new SkillService(options.repository);
  const context = new ContextService(memory, skills, undefined, {
    ...(options.eventSink === undefined ? {} : { eventSink: options.eventSink }),
  }, {
    ...(options.retriever === undefined ? {} : { retriever: options.retriever }),
  });
  const proposals = options.llmProvider
    ? new ProposalService({ memory, skills, repository: options.repository, provider: options.llmProvider })
    : undefined;
  const embeddingSync = options.embedding
    ? new EmbeddingSyncService(memory, skills, options.embedding.provider, options.embedding.index, {
      ...(options.embedding.batchSize === undefined ? {} : { batchSize: options.embedding.batchSize }),
    })
    : undefined;
  const feedback = new FeedbackService(options.repository);

  return createServer(async (request, response) => {
    try {
      await route(request, response, memory, skills, context, proposals, embeddingSync, feedback, options.repository, options.accessKey, options.webRoot, options.eventSink);
    } catch (error) {
      const status = error instanceof DomainError
        ? error.status
        : error instanceof SkillVersionConflictError || error instanceof GovernanceError
          ? 409
          : isSqliteConflict(error) ? 409 : 400;
      send(response, status, {
        error: error instanceof DomainError
          ? error.code
          : error instanceof SkillVersionConflictError
            ? "VERSION_CONFLICT"
            : error instanceof GovernanceError
              ? error.code
              : isSqliteConflict(error) ? "CONFLICT" : "BAD_REQUEST",
        message: error instanceof Error ? error.message : "request failed",
      });
    }
  });
}

async function route(
  request: IncomingMessage,
  response: ServerResponse,
  memory: MemoryService,
  skills: SkillService,
  context: ContextService,
  proposals: ProposalService | undefined,
  embeddingSync: EmbeddingSyncService | undefined,
  feedback: FeedbackService,
  repository: SqliteRepository,
  accessKey: string,
  webRoot?: string,
  eventSink?: EventSink,
): Promise<void> {
  const method = request.method ?? "GET";
  const url = new URL(request.url ?? "/", "http://localhost");

  if (method === "GET" && url.pathname === "/health") {
    send(response, 200, { ok: true });
    return;
  }

  if (method === "POST" && url.pathname === "/v1/auth/login") {
    const body = await readJson(request) as { accessKey?: string };
    if (!body.accessKey || !accessKeyMatches(body.accessKey, accessKey)) {
      send(response, 401, { error: "UNAUTHORIZED", message: "invalid access key" });
      return;
    }
    send(response, 200, {
      authenticated: true,
      user: { id: "local-admin", name: "Local Administrator" },
    });
    return;
  }

  if (url.pathname.startsWith("/v1/")) {
    const token = bearerToken(request.headers.authorization);
    if (!token || !accessKeyMatches(token, accessKey)) {
      send(response, 401, { error: "UNAUTHORIZED", message: "authentication required" });
      return;
    }
  }

  if (method === "POST" && url.pathname === "/v1/evidence") {
    send(response, 200, memory.capture(await readJson(request) as Parameters<MemoryService["capture"]>[0]));
    return;
  }

  if (method === "DELETE" && url.pathname.startsWith("/v1/evidence/")) {
    const body = await readJson(request) as { scope: Parameters<MemoryService["deleteEvidence"]>[1] };
    send(response, 200, memory.deleteEvidence(decodeURIComponent(url.pathname.slice("/v1/evidence/".length)), body.scope));
    return;
  }

  if (method === "POST" && url.pathname === "/v1/evidence/get") {
    // 批量取证据原文（严格限定作用域）：供 Web 审核时对照 Draft 的来源
    const body = await readJson(request) as {
      scope: Parameters<MemoryService["deleteEvidence"]>[1];
      ids: string[];
    };
    if (!Array.isArray(body.ids)) {
      send(response, 400, { error: "BAD_REQUEST", message: "ids must be an array" });
      return;
    }
    const items = body.ids
      .map((id) => repository.getEvidenceScoped(id, body.scope))
      .filter((evidence): evidence is NonNullable<typeof evidence> => evidence !== undefined);
    send(response, 200, { items });
    return;
  }

  if (method === "POST" && (url.pathname === "/v1/proposals/memory/run" || url.pathname === "/v1/proposals/skill/run")) {
    // 人工触发的提案 API：无论模型输出什么，只会创建 Draft，不会直接产生 Verified 资产
    if (!proposals) {
      send(response, 503, { error: "LLM_CONFIG_ERROR", message: "LLM Provider 未配置或初始化失败，提案功能不可用" });
      return;
    }
    const input = await readJson(request) as ProposalJobInput;
    const report = url.pathname === "/v1/proposals/memory/run"
      ? await proposals.runMemoryProposal(input)
      : await proposals.runSkillProposal(input);
    send(response, 200, report);
    return;
  }

  if (method === "POST" && url.pathname === "/v1/memories") {
    send(response, 200, memory.propose(await readJson(request) as Parameters<MemoryService["propose"]>[0]));
    return;
  }

  if (method === "POST" && url.pathname === "/v1/memories/get") {
    const body = await readJson(request) as { id: string; scope: Parameters<MemoryService["get"]>[1] };
    const item = memory.get(body.id, body.scope);
    send(response, item ? 200 : 404, item ?? { error: "NOT_FOUND", message: `memory not found: ${body.id}` });
    return;
  }

  if (method === "POST" && url.pathname === "/v1/memories/list") {
    const body = await readJson(request) as { scope: Parameters<MemoryService["list"]>[0] };
    send(response, 200, { items: memory.list(body.scope) });
    return;
  }

  const memoryStatus = url.pathname.match(/^\/v1\/memories\/([^/]+)\/status$/);
  if (method === "POST" && memoryStatus) {
    const body = await readJson(request) as { scope: Parameters<MemoryService["transition"]>[1]; target: GovernedStatus };
    const asset = memory.transition(decodeURIComponent(memoryStatus[1]!), body.scope, body.target);
    // 治理转换成功后自动同步向量索引：同步是索引维护而非提案/发布，
    // 失败只记事件，绝不影响治理操作本身的结果
    await syncVectorsAfterTransition(embeddingSync, eventSink, {
      trigger: "memory.transition",
      assetKind: "memory",
      assetId: asset.id,
      scope: asset.scope,
    });
    send(response, 200, asset);
    return;
  }

  if (method === "POST" && url.pathname === "/v1/recall") {
    const body = await readJson(request) as Parameters<MemoryService["recall"]>[0];
    send(response, 200, { items: memory.recall(body) });
    return;
  }

  if (method === "POST" && url.pathname === "/v1/context/recall") {
    send(response, 200, await context.recall(await readJson(request) as Parameters<ContextService["recall"]>[0]));
    return;
  }

  if (method === "POST" && url.pathname === "/v1/retrieval/sync") {
    // 人工触发的向量索引同步：只写入 embedding 元数据，不改动任何治理资产
    if (!embeddingSync) {
      send(response, 503, { error: "EMBEDDING_CONFIG_ERROR", message: "Embedding Provider 未配置，向量同步不可用" });
      return;
    }
    const body = await readJson(request) as { scope: Scope; includeDraft?: boolean };
    if (!body.scope || typeof body.scope !== "object") {
      send(response, 400, { error: "BAD_REQUEST", message: "scope is required" });
      return;
    }
    send(response, 200, await embeddingSync.sync({
      scope: body.scope,
      ...(body.includeDraft === undefined ? {} : { includeDraft: body.includeDraft }),
    }));
    return;
  }

  if (method === "POST" && url.pathname === "/v1/skills") {
    send(response, 200, skills.create(await readJson(request) as Parameters<SkillService["create"]>[0]));
    return;
  }

  if (method === "POST" && url.pathname === "/v1/skills/get") {
    const body = await readJson(request) as { id: string; scope: Parameters<SkillService["get"]>[1] };
    const item = skills.get(body.id, body.scope);
    send(response, item ? 200 : 404, item ?? { error: "NOT_FOUND", message: `skill not found: ${body.id}` });
    return;
  }

  if (method === "POST" && url.pathname === "/v1/skills/list") {
    const body = await readJson(request) as { scope: Parameters<SkillService["list"]>[0] };
    send(response, 200, { items: skills.list(body.scope) });
    return;
  }

  const skillUpdate = url.pathname.match(/^\/v1\/skills\/([^/]+)$/);
  if (method === "PUT" && skillUpdate) {
    const body = await readJson(request) as Omit<Parameters<SkillService["update"]>[0], "id">;
    send(response, 200, skills.update({ ...body, id: decodeURIComponent(skillUpdate[1]!) }));
    return;
  }

  const skillStatus = url.pathname.match(/^\/v1\/skills\/([^/]+)\/status$/);
  if (method === "POST" && skillStatus) {
    const body = await readJson(request) as { scope: Parameters<SkillService["transition"]>[1]; target: GovernedStatus };
    const skill = skills.transition(decodeURIComponent(skillStatus[1]!), body.scope, body.target);
    // 与记忆转换一致：Verify/Reject 等状态变化后自动对齐向量索引
    await syncVectorsAfterTransition(embeddingSync, eventSink, {
      trigger: "skill.transition",
      assetKind: "skill",
      assetId: skill.id,
      scope: skill.scope,
    });
    send(response, 200, skill);
    return;
  }

  if (method === "POST" && url.pathname === "/v1/skills/search") {
    const body = await readJson(request) as {
      query: string;
      scope: Parameters<SkillService["search"]>[1];
      includeDraft?: boolean;
    };
    send(response, 200, { items: skills.search(body.query, body.scope, body.includeDraft) });
    return;
  }

  if (method === "POST" && url.pathname === "/v1/feedback") {
    // 显式反馈：只采集人工判断（四分类 + 关联召回请求与资产版本），
    // 不触发任何资产状态或内容的自动变更
    const body = await readJson(request) as {
      id?: string;
      assetKind: FeedbackAssetKind;
      assetId: string;
      scope: Scope;
      kind: FeedbackKind;
      requestId?: string;
      comment?: string;
    };
    if (!body.scope || typeof body.scope !== "object") {
      send(response, 400, { error: "BAD_REQUEST", message: "scope is required" });
      return;
    }
    if (!body.assetId || !body.assetKind || !body.kind) {
      send(response, 400, { error: "BAD_REQUEST", message: "assetKind, assetId and kind are required" });
      return;
    }
    send(response, 200, feedback.submit(body));
    return;
  }

  if (method === "POST" && url.pathname === "/v1/feedback/list") {
    const body = await readJson(request) as { scope: Scope };
    if (!body.scope || typeof body.scope !== "object") {
      send(response, 400, { error: "BAD_REQUEST", message: "scope is required" });
      return;
    }
    send(response, 200, { items: feedback.list(body.scope) });
    return;
  }

  if (method === "GET" && !url.pathname.startsWith("/v1/") && webRoot && await serveWeb(response, webRoot, url.pathname)) return;

  send(response, 404, { error: "NOT_FOUND", message: "route not found" });
}

/**
 * 治理状态转换成功后的自动向量同步：把该资产作用域内可召回资产增量
 * 同步进向量索引（内容指纹未变则跳过，开销与变更资产数成正比）。
 * 解决的问题：hybrid 模式下新 Verify 的资产若忘记手动 /v1/retrieval/sync，
 * 在此之前只走词法通道。同步属于索引维护而非提案或发布，在治理边界内；
 * 词法模式（未注入向量组件）直接跳过，任何失败只记事件、不影响治理操作。
 */
async function syncVectorsAfterTransition(
  embeddingSync: EmbeddingSyncService | undefined,
  eventSink: EventSink | undefined,
  input: { trigger: string; assetKind: AssetKind; assetId: string; scope: Scope },
): Promise<void> {
  if (!embeddingSync) return;
  try {
    const report = await embeddingSync.sync({ scope: input.scope });
    if (!eventSink) return;
    const event: RetrievalAutoSyncCompletedEvent = {
      schemaVersion: EVENT_SCHEMA_VERSION,
      eventType: "retrieval.auto_sync.completed",
      timestamp: new Date().toISOString(),
      trigger: input.trigger,
      assetKind: input.assetKind,
      assetId: input.assetId,
      scope: input.scope,
      embedded: report.memories.embedded + report.skills.embedded,
      removed: report.memories.removed + report.skills.removed,
    };
    eventSink.emit(event);
  } catch (error) {
    if (!eventSink) return;
    const event: RetrievalAutoSyncFailedEvent = {
      schemaVersion: EVENT_SCHEMA_VERSION,
      eventType: "retrieval.auto_sync.failed",
      timestamp: new Date().toISOString(),
      trigger: input.trigger,
      assetKind: input.assetKind,
      assetId: input.assetId,
      scope: input.scope,
      // 只记错误码与错误名；错误消息可能拼接资产内容，不进入事件
      errorCode: errorCodeFor(error),
      errorName: error instanceof Error ? error.name : "UnknownError",
    };
    eventSink.emit(event);
  }
}

async function serveWeb(response: ServerResponse, webRoot: string, pathname: string): Promise<boolean> {
  const root = resolve(webRoot);
  const decoded = decodeURIComponent(pathname);
  const relative = normalize(decoded).replace(/^[/\\]+/, "");
  const candidate = resolve(join(root, relative));
  if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) return false;

  let filePath = candidate;
  try {
    if ((await stat(filePath)).isDirectory()) filePath = join(filePath, "index.html");
  } catch {
    filePath = join(root, "index.html");
  }

  try {
    const body = await readFile(filePath);
    response.writeHead(200, {
      "content-type": contentType(filePath),
      "content-length": body.length,
      "cache-control": filePath.endsWith("index.html") ? "no-cache" : "public, max-age=31536000, immutable",
    });
    response.end(body);
    return true;
  } catch {
    return false;
  }
}

function contentType(filePath: string): string {
  return ({
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
  } as Record<string, string>)[extname(filePath)] ?? "application/octet-stream";
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 1_000_000) throw new Error("request body exceeds 1MB");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function send(response: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(json),
  });
  response.end(json);
}

function isSqliteConflict(error: unknown): boolean {
  return typeof error === "object" && error !== null
    && "code" in error && String((error as { code: unknown }).code).includes("CONSTRAINT");
}
