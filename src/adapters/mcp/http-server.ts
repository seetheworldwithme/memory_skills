import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Readable } from "node:stream";

import {
  createMcpHandler,
  hostHeaderValidationResponse,
  originValidationResponse,
  type McpHttpHandler,
} from "@modelcontextprotocol/server";

import { resolveAuthServiceFromEnv, type AuthService } from "../../auth/auth-service.js";
import { canPerform } from "../../auth/authorization-policy.js";
import { StderrEventSink, resolveEventSinkFromEnv } from "../../observability/jsonl-event-sink.js";
import { AuditService } from "../../security/audit-service.js";
import { RateLimiter, resolveRateLimitRulesFromEnv } from "../../security/rate-limit.js";
import { authenticateMcpRequest, BEARER_CHALLENGE_HEADERS, scopeFromPrincipal } from "./auth.js";
import { MemorySkillsHttpClient } from "./http-client.js";
import { createMemorySkillsMcpServer } from "./server.js";

type Environment = Record<string, string | undefined>;

/** 远程 MCP 主端点路径；宿主统一连 http://<host>:<port>/mcp。 */
export const MCP_HTTP_PATH = "/mcp";

/** 请求体上限，与主服务 HTTP API 的 1MB 红线对齐。 */
export const MCP_MAX_BODY_BYTES = 1_000_000;

export interface McpHttpServerOptions {
  /** 出站客户端：工具执行时回调主服务 HTTP API（与 stdio 适配器同一实现）。 */
  client: MemorySkillsHttpClient;
  /** 入站认证：与主服务同一凭据体系（本地 Access Key + 团队 Token），不产生第二套验签。 */
  authService: AuthService;
  /** 限流与审计；缺省无限流不审计（测试/内嵌场景），独立部署入口会显式注入。 */
  security?: { rateLimiter?: RateLimiter; audit?: AuditService };
  /** Host 头允许列表（DNS rebinding 防护）；未配置则不校验（认证是主防线，见 remote-mcp.md）。 */
  allowedHosts?: readonly string[];
  /** Origin 允许列表；未配置则不校验。公网部署建议配置以拒绝浏览器跨站请求。 */
  allowedOrigins?: readonly string[];
  /** 作用域派生用环境（agentId/sessionId 维度仍由服务端绑定）。 */
  environment?: Environment;
}

/**
 * 远程 MCP（Streamable HTTP）服务（Task 19）：
 * - 工具行为 100% 复用 tool-catalog.ts 单一目录与 createMemorySkillsMcpServer 工厂，
 *   与 stdio 入口零差异；本文件只负责 HTTP 传输、认证、限流与审计的接线；
 * - 无状态逐请求模型（createMcpHandler 默认 stateless）：每个请求由工厂新建 server 实例，
 *   工具全部只读幂等，断线后客户端直接重试即恢复，无需会话存储与事件回放；
 * - 作用域由认证主体派生（auth.ts scopeFromPrincipal），请求输入无法覆盖。
 */
export function createMcpHttpServer(options: McpHttpServerOptions): Server {
  const rateLimiter = options.security?.rateLimiter;
  const audit = options.security?.audit;
  const environment = options.environment ?? {};
  // 按认证主体缓存 handler：同一主体的多个请求复用同一工厂闭包，
  // 数量上界 = Token 数（配置文件级），无需淘汰策略
  const handlers = new Map<string, McpHttpHandler>();

  function handlerFor(principal: { userId: string; teamId: string }): McpHttpHandler {
    const key = `${principal.userId}@${principal.teamId}`;
    const existing = handlers.get(key);
    if (existing) return existing;
    // 作用域在缓存创建时按主体派生一次（只依赖 userId/teamId 与环境 agentId/sessionId，
    // 与角色无关，因此按主体缓存不会失真）：身份是作用域唯一权威，调用方无法越权声明
    const defaultScope = scopeFromPrincipal(principal, environment);
    const created = createMcpHandler(
      () => createMemorySkillsMcpServer({ client: options.client, defaultScope }),
      { onerror: (error) => console.error(`[memory-skills-mcp-http] ${error.message}`) },
    );
    handlers.set(key, created);
    return created;
  }

  const server = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      console.error(`[memory-skills-mcp-http] unhandled: ${error instanceof Error ? error.message : String(error)}`);
      if (!response.headersSent) {
        response.writeHead(500, { "content-type": "application/json" });
      }
      response.end(JSON.stringify({ error: "INTERNAL", message: "internal error" }));
    });
  });

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://localhost");
    const method = request.method ?? "GET";

    // 健康检查：无认证、不泄漏配置，供容器 HEALTHCHECK 与负载均衡探测
    if (method === "GET" && url.pathname === "/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    if (url.pathname !== MCP_HTTP_PATH) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "NOT_FOUND", message: `unknown path: ${url.pathname}` }));
      return;
    }

    // 认证先行（只读头部，不读请求体）：匿名大负载在消耗任何解析成本前就被拒绝
    const authResult = authenticateMcpRequest(options.authService, request.headers.authorization);
    if (!authResult.ok) {
      audit?.denied({ path: url.pathname, code: "UNAUTHORIZED" });
      response.writeHead(401, { "content-type": "application/json", ...BEARER_CHALLENGE_HEADERS });
      response.end(JSON.stringify({ error: "UNAUTHORIZED", message: "authentication required" }));
      return;
    }
    const principal = authResult.principal;

    // 授权：远程 MCP 只承载只读工具，动作恒为 read（角色矩阵 reader/reviewer/admin 均放行）
    if (!canPerform(principal, "read")) {
      audit?.denied({ principal, path: url.pathname, code: "FORBIDDEN_ACTION", action: "read" });
      response.writeHead(403, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "FORBIDDEN_ACTION", message: "read action not allowed" }));
      return;
    }

    // 限流：read 域按认证主体计数，与主服务同一 RateLimiter 语义
    if (rateLimiter) {
      const verdict = rateLimiter.consume("read", principal.userId);
      if (!verdict.allowed) {
        audit?.denied({ principal, path: url.pathname, code: "RATE_LIMITED", action: "read" });
        response.writeHead(429, {
          "content-type": "application/json",
          "retry-after": String(verdict.retryAfterSeconds),
        });
        response.end(JSON.stringify({ error: "RATE_LIMITED", retryAfterSeconds: verdict.retryAfterSeconds }));
        return;
      }
    }

    if (method !== "POST" && method !== "GET" && method !== "DELETE") {
      response.writeHead(405, { allow: "POST, GET, DELETE", "content-type": "application/json" });
      response.end(JSON.stringify({ error: "METHOD_NOT_ALLOWED", message: `${method} not supported` }));
      return;
    }

    // Node ↔ Web 标准桥接：SDK 传输层以 Web Request/Response 工作
    let webRequest: Request;
    try {
      webRequest = await toWebRequest(request, method);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const tooLarge = message === "request body exceeds 1MB";
      response.writeHead(tooLarge ? 413 : 400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: tooLarge ? "PAYLOAD_TOO_LARGE" : "BAD_REQUEST", message }));
      return;
    }

    // Host/Origin 校验（配置允许列表后启用）：SDK 官方组合模式
    const rejected = (options.allowedHosts ? hostHeaderValidationResponse(webRequest, [...options.allowedHosts]) : undefined)
      ?? (options.allowedOrigins ? originValidationResponse(webRequest, [...options.allowedOrigins]) : undefined);
    if (rejected) {
      await sendWebResponse(response, rejected);
      return;
    }

    const handler = handlerFor(principal);
    const webResponse = await handler.fetch(webRequest);
    await sendWebResponse(response, webResponse);
  }

  server.on("close", () => {
    for (const handler of handlers.values()) {
      void handler.close().catch((error: unknown) => {
        console.error(`[memory-skills-mcp-http] close: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
    handlers.clear();
  });

  return server;
}

/** Node 请求 → Web 标准 Request；POST 请求体带 1MB 上限（与主服务红线一致）。 */
async function toWebRequest(request: IncomingMessage, method: string): Promise<Request> {
  const url = new URL(request.url ?? "/", "http://localhost");
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) headers.set(name, value.join(", "));
    else headers.set(name, value);
  }
  let body: Uint8Array<ArrayBuffer> | undefined;
  if (method === "POST") {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      if (size > MCP_MAX_BODY_BYTES) throw new Error("request body exceeds 1MB");
      chunks.push(chunk as Buffer);
    }
    if (chunks.length > 0) {
      // 拷贝到独立 ArrayBuffer：exactOptionalPropertyTypes 下 BodyInit 需要
      // Uint8Array<ArrayBuffer>，池化 Buffer（ArrayBufferLike）不满足该窄化
      const merged = Buffer.concat(chunks);
      body = new Uint8Array(merged.byteLength);
      body.set(merged);
    }
  }
  return new Request(url, { method, headers, ...(body === undefined ? {} : { body }) });
}

/** Web 标准 Response → Node 响应：逐块流式转发，不整包缓冲。 */
async function sendWebResponse(response: ServerResponse, webResponse: Response): Promise<void> {
  const headers: Record<string, string> = {};
  webResponse.headers.forEach((value, key) => {
    headers[key] = value;
  });
  response.writeHead(webResponse.status, headers);
  if (webResponse.body === null) {
    response.end();
    return;
  }
  const nodeStream = Readable.fromWeb(webResponse.body as import("node:stream/web").ReadableStream);
  await new Promise<void>((resolve, reject) => {
    nodeStream.on("error", reject);
    response.on("close", resolve);
    nodeStream.pipe(response);
    nodeStream.on("end", resolve);
  });
}

/**
 * 独立部署入口：环境变量与 stdio 适配器同一套（MEMORY_SKILLS_URL 指向主服务），
 * 另加远程端点自身的监听与防护变量（MEMORY_SKILLS_MCP_*，见 .env.example 与 remote-mcp.md）。
 */
if (isMainModule()) {
  const environment: Environment = process.env;
  const host = environment.MEMORY_SKILLS_MCP_HOST?.trim() || "127.0.0.1";
  const port = Number.parseInt(environment.MEMORY_SKILLS_MCP_PORT ?? "8422", 10);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    console.error(`[memory-skills-mcp-http] MEMORY_SKILLS_MCP_PORT 非法：${environment.MEMORY_SKILLS_MCP_PORT}`);
    process.exit(1);
  }
  const allowedHosts = parseList(environment.MEMORY_SKILLS_MCP_ALLOWED_HOSTS);
  const allowedOrigins = parseList(environment.MEMORY_SKILLS_MCP_ALLOWED_ORIGINS);

  const client = MemorySkillsHttpClient.fromEnv(environment);
  resolveAuthServiceFromEnv(environment)
    .then((authService) => {
      // 事件默认 stderr：远程 MCP 与主服务是两个进程，避免争写同一 events.jsonl；
      // 显式配置 MEMORY_SKILLS_EVENT_SINK 时按环境变量走（如独立文件或 off）
      const sink = environment.MEMORY_SKILLS_EVENT_SINK?.trim()
        ? resolveEventSinkFromEnv(environment)
        : new StderrEventSink();
      const server = createMcpHttpServer({
        client,
        authService,
        security: {
          rateLimiter: new RateLimiter(resolveRateLimitRulesFromEnv(environment)),
          audit: new AuditService(sink),
        },
        ...(allowedHosts.length > 0 ? { allowedHosts } : {}),
        ...(allowedOrigins.length > 0 ? { allowedOrigins } : {}),
        environment,
      });
      server.listen(port, host, () => {
        console.error(`[memory-skills-mcp-http] listening on http://${host}:${port}${MCP_HTTP_PATH}`);
      });
      const shutdown = () => {
        server.close(() => process.exit(0));
      };
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
    })
    .catch((error: unknown) => {
      // fail-fast：认证配置错误（Access Key 缺失、Token 文件损坏）绝不静默降级
      console.error(`[memory-skills-mcp-http] 启动失败：${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    });
}

/** 逗号分隔的允许列表解析：空/未配置返回空数组（表示不启用校验）。 */
function parseList(raw: string | undefined): string[] {
  return (raw ?? "").split(",").map((item) => item.trim()).filter((item) => item.length > 0);
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  return Boolean(entry && import.meta.url === new URL(`file://${entry}`).href);
}
