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

export function createMemorySkillsServer(options: {
  repository: SqliteRepository;
  accessKey: string;
  webRoot?: string;
  eventSink?: EventSink;
  /** 模型 Provider：未注入时提案 API 返回 503，其余能力不受影响。 */
  llmProvider?: LlmProvider;
}): Server {
  if (!options.accessKey.trim()) throw new Error("accessKey must not be empty");
  const memory = new MemoryService(options.repository);
  const skills = new SkillService(options.repository);
  const context = new ContextService(memory, skills, undefined, {
    ...(options.eventSink === undefined ? {} : { eventSink: options.eventSink }),
  });
  const proposals = options.llmProvider
    ? new ProposalService({ memory, skills, repository: options.repository, provider: options.llmProvider })
    : undefined;

  return createServer(async (request, response) => {
    try {
      await route(request, response, memory, skills, context, proposals, options.repository, options.accessKey, options.webRoot);
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
  repository: SqliteRepository,
  accessKey: string,
  webRoot?: string,
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
    send(response, 200, memory.transition(decodeURIComponent(memoryStatus[1]!), body.scope, body.target));
    return;
  }

  if (method === "POST" && url.pathname === "/v1/recall") {
    const body = await readJson(request) as Parameters<MemoryService["recall"]>[0];
    send(response, 200, { items: memory.recall(body) });
    return;
  }

  if (method === "POST" && url.pathname === "/v1/context/recall") {
    send(response, 200, context.recall(await readJson(request) as Parameters<ContextService["recall"]>[0]));
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
    send(response, 200, skills.transition(decodeURIComponent(skillStatus[1]!), body.scope, body.target));
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

  if (method === "GET" && !url.pathname.startsWith("/v1/") && webRoot && await serveWeb(response, webRoot, url.pathname)) return;

  send(response, 404, { error: "NOT_FOUND", message: "route not found" });
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
