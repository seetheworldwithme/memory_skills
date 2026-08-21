import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";

import { bearerToken } from "../auth/access-key.js";
import { AuthService } from "../auth/auth-service.js";
import { canPerform, scopeAllowed } from "../auth/authorization-policy.js";
import type { AuthAction, Principal } from "../auth/principal.js";
import { AuditService } from "../security/audit-service.js";
import { RateLimiter } from "../security/rate-limit.js";
import type { GovernedStatus } from "../governance/lifecycle.js";
import { MemoryService } from "../memory/memory-service.js";
import { SkillService, SkillVersionConflictError } from "../skills/skill-service.js";
import type { SqliteRepository } from "../storage/sqlite-repository.js";
import { DomainError } from "../errors.js";
import { readRequestBody } from "./read-request-body.js";
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
import { ConflictService } from "../governance/conflict-service.js";
import { RetentionService } from "../governance/retention-service.js";
import { ImpactAnalysis } from "../governance/impact-analysis.js";
import type { SkillRunEventKind } from "../skills/skill-run-record.js";

export function createMemorySkillsServer(options: {
  repository: SqliteRepository;
  accessKey: string;
  /**
   * 认证服务：注入后 Access Key 与团队 Token 都可认证；
   * 缺省按纯本地模式组装（Access Key -> 全边界 local-admin）。
   */
  authService?: AuthService;
  webRoot?: string;
  eventSink?: EventSink;
  /** 模型 Provider：未注入时提案 API 返回 503，其余能力不受影响。 */
  llmProvider?: LlmProvider;
  /** 检索器：默认词法；注入 HybridRetriever 后 /v1/context/recall 走混合排序。 */
  retriever?: Retriever;
  /** 向量同步组件：注入后开放 /v1/retrieval/sync，缺省时该端点返回 503。 */
  embedding?: { provider: EmbeddingProvider; index: VectorIndex; batchSize?: number };
  /** 安全组件（Task 16）：速率限制与审计；缺省时不限流、不产出审计事件。 */
  security?: { rateLimiter?: RateLimiter; audit?: AuditService };
}): Server {
  if (!options.accessKey.trim()) throw new Error("accessKey must not be empty");
  const auth = options.authService ?? new AuthService({ accessKey: options.accessKey });
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
  const conflicts = new ConflictService(options.repository);
  const retention = new RetentionService(options.repository);
  const impact = new ImpactAnalysis(options.repository);

  return createServer(async (request, response) => {
    try {
      await route(request, response, memory, skills, context, proposals, embeddingSync, feedback, options.repository, auth, options.security, options.webRoot, options.eventSink, conflicts, retention, impact);
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
  auth: AuthService,
  security?: { rateLimiter?: RateLimiter; audit?: AuditService },
  webRoot?: string,
  eventSink?: EventSink,
  conflicts?: ConflictService,
  retention?: RetentionService,
  impact?: ImpactAnalysis,
): Promise<void> {
  const method = request.method ?? "GET";
  const url = new URL(request.url ?? "/", "http://localhost");

  if (method === "GET" && url.pathname === "/health") {
    send(response, 200, { ok: true });
    return;
  }

  if (method === "POST" && url.pathname === "/v1/auth/login") {
    // 登录限流（Task 16）：按来源地址限制尝试总量与失败次数，防凭据爆破。
    // 语义是"限速"而非"锁死"：失败才消耗失败配额，正确登录不受失败计数影响，
    // 攻击者无法通过制造失败把真实用户挡在门外，同时爆破速率被压到限额以内
    const remoteAddress = request.socket.remoteAddress ?? "unknown";
    const body = await readJson(request) as { accessKey?: string };
    if (security?.rateLimiter) {
      const attempts = security.rateLimiter.consume("login", remoteAddress);
      if (!attempts.allowed) {
        security?.audit?.loginFailed({ remoteAddress, reason: "too-many-attempts" });
        return sendRateLimited(response, attempts.retryAfterSeconds);
      }
      const credential = body.accessKey?.trim();
      const credentialValid = credential !== undefined && credential.length > 0 && auth.authenticate(credential) !== undefined;
      if (!credentialValid) {
        const failures = security.rateLimiter.consume("loginFailure", remoteAddress);
        if (!failures.allowed) {
          security?.audit?.loginFailed({ remoteAddress, reason: "too-many-failures" });
          return sendRateLimited(response, failures.retryAfterSeconds);
        }
      }
    }
    const principal = body.accessKey ? auth.authenticate(body.accessKey) : undefined;
    if (!principal) {
      security?.audit?.loginFailed({ remoteAddress, reason: "invalid-credentials" });
      send(response, 401, { error: "UNAUTHORIZED", message: "invalid access key" });
      return;
    }
    send(response, 200, {
      authenticated: true,
      user: { id: principal.userId, name: principal.displayName ?? principal.userId },
      // Task 15：登录即暴露身份与边界，供客户端自查权限；角色只来自认证，不可自报
      principal: {
        userId: principal.userId,
        teamId: principal.teamId,
        roles: principal.roles,
        boundary: principal.boundary,
        source: principal.source,
      },
    });
    return;
  }

  // 认证闸门：/v1/* 一律要求 Bearer Token（本地 Access Key 或团队 Token），
  // 认证结果 Principal 是后续所有动作与作用域授权的唯一依据
  let principal: Principal | undefined;
  if (url.pathname.startsWith("/v1/")) {
    const token = bearerToken(request.headers.authorization);
    principal = token ? auth.authenticate(token) : undefined;
    if (!principal) {
      security?.audit?.denied({ path: url.pathname, code: "UNAUTHORIZED" });
      send(response, 401, { error: "UNAUTHORIZED", message: "authentication required" });
      return;
    }
  }

  if (method === "POST" && url.pathname === "/v1/evidence") {
    const body = await readJson(request) as Parameters<MemoryService["capture"]>[0];
    if (!authorize(principal!, "write", body.scope, url.pathname, response, security)) return;
    send(response, 200, memory.capture(body));
    return;
  }

  if (method === "DELETE" && url.pathname.startsWith("/v1/evidence/")) {
    const body = await readJson(request) as { scope: Parameters<MemoryService["deleteEvidence"]>[1] };
    if (!authorize(principal!, "write", body.scope, url.pathname, response, security)) return;
    const result = memory.deleteEvidence(decodeURIComponent(url.pathname.slice("/v1/evidence/".length)), body.scope);
    // 证据删除的传播审计：派生资产状态由传播结果给出，逐资产记录
    for (const asset of result.memories) {
      security?.audit?.stateChanged({
        principal: principal!, assetKind: "memory", assetId: asset.id, scope: body.scope,
        trigger: "evidence.delete", from: asset.from, to: asset.to,
      });
    }
    for (const asset of result.skills) {
      security?.audit?.stateChanged({
        principal: principal!, assetKind: "skill", assetId: asset.id, scope: body.scope,
        trigger: "evidence.delete", from: asset.from, to: asset.to,
      });
    }
    security?.audit?.stateChanged({
      principal: principal!, assetKind: "evidence", assetId: result.evidenceId, scope: body.scope,
      trigger: "evidence.delete", from: "active", to: "deleted",
    });
    // 删除会批量改变派生资产状态，成功后同步一次该作用域的向量索引；
    // 同步失败只记事件，不影响删除结果
    await syncVectorsAfterTransition(embeddingSync, eventSink, {
      trigger: "evidence.delete",
      assetKind: "memory",
      assetId: result.evidenceId,
      scope: body.scope,
    });
    send(response, 200, result);
    return;
  }

  const evidenceImpact = url.pathname.match(/^\/v1\/evidence\/([^/]+)\/impact$/);
  if (method === "POST" && evidenceImpact && impact) {
    // 删除前的只读影响预览：展示受影响资产与将被传播到的状态，不改动任何数据
    const body = await readJson(request) as { scope: Parameters<MemoryService["deleteEvidence"]>[1] };
    if (!authorize(principal!, "read", body.scope, url.pathname, response, security)) return;
    send(response, 200, impact.evidenceDeletion(decodeURIComponent(evidenceImpact[1]!), body.scope));
    return;
  }

  if (method === "POST" && url.pathname === "/v1/evidence/get") {
    // 批量取证据原文（严格限定作用域）：供 Web 审核时对照 Draft 的来源
    const body = await readJson(request) as {
      scope: Parameters<MemoryService["deleteEvidence"]>[1];
      ids: string[];
    };
    if (!authorize(principal!, "read", body.scope, url.pathname, response, security)) return;
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
    // 人工触发的提案 API：无论模型输出什么，只会创建 Draft，不会直接产生 Verified 资产；
    // 先授权再探测 Provider，未授权者不应得知 LLM 是否配置
    const input = await readJson(request) as ProposalJobInput;
    if (!authorize(principal!, "write", input.scope, url.pathname, response, security)) return;
    if (!proposals) {
      send(response, 503, { error: "LLM_CONFIG_ERROR", message: "LLM Provider 未配置或初始化失败，提案功能不可用" });
      return;
    }
    // 提案审计（Task 16）：成败都记录，错误只记码不记正文（Prompt/输出绝不进事件）
    const proposalKind = url.pathname === "/v1/proposals/memory/run" ? "memory" as const : "skill" as const;
    try {
      const report = proposalKind === "memory"
        ? await proposals.runMemoryProposal(input)
        : await proposals.runSkillProposal(input);
      security?.audit?.proposalRun({ principal: principal!, kind: proposalKind, ok: true });
      send(response, 200, report);
    } catch (error) {
      security?.audit?.proposalRun({
        principal: principal!, kind: proposalKind, ok: false,
        errorCode: error instanceof DomainError ? error.code : "PROPOSAL_FAILED",
      });
      throw error;
    }
    return;
  }

  if (method === "POST" && url.pathname === "/v1/memories") {
    const body = await readJson(request) as Parameters<MemoryService["propose"]>[0];
    if (!authorize(principal!, "write", body.scope, url.pathname, response, security)) return;
    send(response, 200, memory.propose(body));
    return;
  }

  if (method === "POST" && url.pathname === "/v1/memories/get") {
    const body = await readJson(request) as { id: string; scope: Parameters<MemoryService["get"]>[1] };
    if (!authorize(principal!, "read", body.scope, url.pathname, response, security)) return;
    const item = memory.get(body.id, body.scope);
    send(response, item ? 200 : 404, item ?? { error: "NOT_FOUND", message: `memory not found: ${body.id}` });
    return;
  }

  if (method === "POST" && url.pathname === "/v1/memories/list") {
    const body = await readJson(request) as { scope: Parameters<MemoryService["list"]>[0] };
    if (!authorize(principal!, "read", body.scope, url.pathname, response, security)) return;
    send(response, 200, { items: memory.list(body.scope) });
    return;
  }

  const memoryStatus = url.pathname.match(/^\/v1\/memories\/([^/]+)\/status$/);
  if (method === "POST" && memoryStatus) {
    const body = await readJson(request) as { scope: Parameters<MemoryService["transition"]>[1]; target: GovernedStatus };
    if (!authorize(principal!, "review", body.scope, url.pathname, response, security)) return;
    const memoryId = decodeURIComponent(memoryStatus[1]!);
    // 审计需要变更前状态：scoped 查一次旧值，资产不存在时 transition 自会 404
    const before = memory.get(memoryId, body.scope)?.governance.status ?? "unknown";
    const asset = memory.transition(memoryId, body.scope, body.target);
    security?.audit?.stateChanged({
      principal: principal!, assetKind: "memory", assetId: memoryId, scope: body.scope,
      trigger: "memory.transition", from: before, to: asset.governance.status,
    });
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
    if (!authorize(principal!, "read", body.scope, url.pathname, response, security)) return;
    if (!draftVisible(principal!, body.includeDraft === true, response)) return;
    send(response, 200, { items: memory.recall(body) });
    return;
  }

  if (method === "POST" && url.pathname === "/v1/context/recall") {
    const body = await readJson(request) as Parameters<ContextService["recall"]>[0];
    if (!authorize(principal!, "read", body.scope, url.pathname, response, security)) return;
    if (!draftVisible(principal!, body.includeDraft === true, response)) return;
    send(response, 200, await context.recall(body));
    return;
  }

  if (method === "POST" && url.pathname === "/v1/retrieval/sync") {
    // 人工触发的向量索引同步：只写入 embedding 元数据，不改动任何治理资产；
    // 先授权再探测能力，未授权者不应得知 Embedding 是否配置
    const body = await readJson(request) as { scope: Scope; includeDraft?: boolean };
    if (!authorize(principal!, "write", body.scope, url.pathname, response, security)) return;
    if (!embeddingSync) {
      send(response, 503, { error: "EMBEDDING_CONFIG_ERROR", message: "Embedding Provider 未配置，向量同步不可用" });
      return;
    }
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
    const body = await readJson(request) as Parameters<SkillService["create"]>[0];
    if (!authorize(principal!, "write", body.scope, url.pathname, response, security)) return;
    send(response, 200, skills.create(body));
    return;
  }

  if (method === "POST" && url.pathname === "/v1/skills/get") {
    const body = await readJson(request) as { id: string; scope: Parameters<SkillService["get"]>[1] };
    if (!authorize(principal!, "read", body.scope, url.pathname, response, security)) return;
    const item = skills.get(body.id, body.scope);
    send(response, item ? 200 : 404, item ?? { error: "NOT_FOUND", message: `skill not found: ${body.id}` });
    return;
  }

  if (method === "POST" && url.pathname === "/v1/skills/list") {
    const body = await readJson(request) as { scope: Parameters<SkillService["list"]>[0] };
    if (!authorize(principal!, "read", body.scope, url.pathname, response, security)) return;
    send(response, 200, { items: skills.list(body.scope) });
    return;
  }

  const skillUpdate = url.pathname.match(/^\/v1\/skills\/([^/]+)$/);
  if (method === "PUT" && skillUpdate) {
    const body = await readJson(request) as Omit<Parameters<SkillService["update"]>[0], "id">;
    if (!authorize(principal!, "write", body.scope, url.pathname, response, security)) return;
    send(response, 200, skills.update({ ...body, id: decodeURIComponent(skillUpdate[1]!) }));
    return;
  }

  const skillStatus = url.pathname.match(/^\/v1\/skills\/([^/]+)\/status$/);
  if (method === "POST" && skillStatus) {
    const body = await readJson(request) as { scope: Parameters<SkillService["transition"]>[1]; target: GovernedStatus };
    if (!authorize(principal!, "review", body.scope, url.pathname, response, security)) return;
    const skillId = decodeURIComponent(skillStatus[1]!);
    const before = skills.get(skillId, body.scope)?.status ?? "unknown";
    const skill = skills.transition(skillId, body.scope, body.target);
    security?.audit?.stateChanged({
      principal: principal!, assetKind: "skill", assetId: skillId, scope: body.scope,
      trigger: "skill.transition", from: before, to: skill.status,
    });
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

  // Task 13：Skill 版本差异 / 回滚 / 质量校验 / 使用记录 / 使用效果
  const skillSubAction = url.pathname.match(/^\/v1\/skills\/([^/]+)\/(versions|diff|rollback|validate|runs|run-summary)$/);
  if (method === "POST" && skillSubAction) {
    const skillId = decodeURIComponent(skillSubAction[1]!);
    const action = skillSubAction[2]!;
    if (action === "versions") {
      const body = await readJson(request) as { scope: Parameters<SkillService["listVersions"]>[1] };
      if (!authorize(principal!, "read", body.scope, url.pathname, response, security)) return;
      send(response, 200, { items: skills.listVersions(skillId, body.scope) });
      return;
    }
    if (action === "diff") {
      const body = await readJson(request) as {
        scope: Parameters<SkillService["diff"]>[1];
        fromVersion?: number;
        toVersion?: number;
      };
      if (!authorize(principal!, "read", body.scope, url.pathname, response, security)) return;
      send(response, 200, skills.diff(skillId, body.scope, {
        ...(body.fromVersion === undefined ? {} : { fromVersion: body.fromVersion }),
        ...(body.toVersion === undefined ? {} : { toVersion: body.toVersion }),
      }));
      return;
    }
    if (action === "rollback") {
      const body = await readJson(request) as {
        scope: Parameters<SkillService["rollback"]>[1];
        targetVersion: number;
      };
      if (!authorize(principal!, "review", body.scope, url.pathname, response, security)) return;
      if (!Number.isInteger(body.targetVersion) || body.targetVersion <= 0) {
        send(response, 400, { error: "BAD_REQUEST", message: "targetVersion must be a positive integer" });
        return;
      }
      const skill = skills.rollback(skillId, body.scope, body.targetVersion);
      security?.audit?.stateChanged({
        principal: principal!, assetKind: "skill", assetId: skillId, scope: body.scope,
        trigger: "skill.rollback", from: "verified", to: skill.status,
      });
      // 回滚产生了新 Draft 版本（内容变化），对齐向量索引
      await syncVectorsAfterTransition(embeddingSync, eventSink, {
        trigger: "skill.rollback",
        assetKind: "skill",
        assetId: skill.id,
        scope: skill.scope,
      });
      send(response, 200, skill);
      return;
    }
    if (action === "validate") {
      const body = await readJson(request) as { scope: Parameters<SkillService["validate"]>[1] };
      if (!authorize(principal!, "read", body.scope, url.pathname, response, security)) return;
      send(response, 200, skills.validate(skillId, body.scope));
      return;
    }
    if (action === "runs") {
      const body = await readJson(request) as {
        scope: Parameters<SkillService["recordRun"]>[0]["scope"];
        event: SkillRunEventKind;
        requestId?: string;
        note?: string;
      };
      // 使用记录是使用证据采集（与显式反馈同级），不改变资产状态，read 即可
      if (!authorize(principal!, "read", body.scope, url.pathname, response, security)) return;
      if (!body.event) {
        send(response, 400, { error: "BAD_REQUEST", message: "event is required" });
        return;
      }
      send(response, 200, skills.recordRun({
        skillId,
        scope: body.scope,
        event: body.event,
        ...(body.requestId === undefined ? {} : { requestId: body.requestId }),
        ...(body.note === undefined ? {} : { note: body.note }),
      }));
      return;
    }
    // run-summary
    const body = await readJson(request) as { scope: Parameters<SkillService["runSummary"]>[1] };
    if (!authorize(principal!, "read", body.scope, url.pathname, response, security)) return;
    send(response, 200, skills.runSummary(skillId, body.scope));
    return;
  }

  if (method === "POST" && url.pathname === "/v1/skills/search") {
    const body = await readJson(request) as {
      query: string;
      scope: Parameters<SkillService["search"]>[1];
      includeDraft?: boolean;
    };
    if (!authorize(principal!, "read", body.scope, url.pathname, response, security)) return;
    if (!draftVisible(principal!, body.includeDraft === true, response)) return;
    send(response, 200, { items: skills.search(body.query, body.scope, body.includeDraft) });
    return;
  }

  if (method === "POST" && url.pathname === "/v1/feedback") {
    // 显式反馈：只采集人工判断（四分类 + 关联召回请求与资产版本），
    // 不触发任何资产状态或内容的自动变更；read 即可提交，鼓励所有能读取的身份反馈
    const body = await readJson(request) as {
      id?: string;
      assetKind: FeedbackAssetKind;
      assetId: string;
      scope: Scope;
      kind: FeedbackKind;
      requestId?: string;
      comment?: string;
    };
    if (!authorize(principal!, "read", body.scope, url.pathname, response, security)) return;
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
    if (!authorize(principal!, "review", body.scope, url.pathname, response, security)) return;
    if (!body.scope || typeof body.scope !== "object") {
      send(response, 400, { error: "BAD_REQUEST", message: "scope is required" });
      return;
    }
    send(response, 200, { items: feedback.list(body.scope) });
    return;
  }

  // Task 14：治理任务（冲突/重复扫描）、保留策略（过期待复核/续期）
  // 治理工作台数据（含资产内容摘要）只对具备审核能力的角色开放
  if (method === "POST" && url.pathname === "/v1/governance/conflicts") {
    const body = await readJson(request) as { scope: Scope };
    if (!authorize(principal!, "review", body.scope, url.pathname, response, security)) return;
    if (!body.scope || typeof body.scope !== "object") {
      send(response, 400, { error: "BAD_REQUEST", message: "scope is required" });
      return;
    }
    send(response, 200, { items: conflicts ? conflicts.listTasks(body.scope) : [] });
    return;
  }

  if (method === "POST" && url.pathname === "/v1/governance/retention/review") {
    const body = await readJson(request) as { scope: Scope; staleDays?: number };
    if (!authorize(principal!, "review", body.scope, url.pathname, response, security)) return;
    if (!body.scope || typeof body.scope !== "object") {
      send(response, 400, { error: "BAD_REQUEST", message: "scope is required" });
      return;
    }
    send(response, 200, retention!.review(body.scope, {
      ...(body.staleDays === undefined ? {} : { staleDays: body.staleDays }),
    }));
    return;
  }

  if (method === "POST" && url.pathname === "/v1/governance/retention/deprecate-expired") {
    const body = await readJson(request) as { scope: Scope };
    if (!authorize(principal!, "review", body.scope, url.pathname, response, security)) return;
    if (!body.scope || typeof body.scope !== "object") {
      send(response, 400, { error: "BAD_REQUEST", message: "scope is required" });
      return;
    }
    const result = retention!.deprecateExpired(body.scope);
    // 批量降权的传播审计：逐资产记录状态转换
    for (const asset of result.memories) {
      security?.audit?.stateChanged({
        principal: principal!, assetKind: "memory", assetId: asset.id, scope: body.scope,
        trigger: "retention.deprecate_expired", from: asset.from, to: asset.to,
      });
    }
    // 降权改变了资产状态，成功后同步一次该作用域的向量索引
    await syncVectorsAfterTransition(embeddingSync, eventSink, {
      trigger: "retention.deprecate_expired",
      assetKind: "memory",
      assetId: result.memories[0]?.id ?? "none",
      scope: body.scope,
    });
    send(response, 200, result);
    return;
  }

  const memoryRenew = url.pathname.match(/^\/v1\/governance\/memories\/([^/]+)\/renew$/);
  if (method === "POST" && memoryRenew) {
    const body = await readJson(request) as {
      scope: Parameters<RetentionService["renewMemory"]>[1];
      validUntil?: string | null;
    };
    if (!authorize(principal!, "review", body.scope, url.pathname, response, security)) return;
    const renewId = decodeURIComponent(memoryRenew[1]!);
    const renewBefore = memory.get(renewId, body.scope)?.governance.status ?? "unknown";
    const asset = retention!.renewMemory(renewId, body.scope, {
      ...(body.validUntil === undefined ? {} : { validUntil: body.validUntil }),
    });
    security?.audit?.stateChanged({
      principal: principal!, assetKind: "memory", assetId: renewId, scope: body.scope,
      trigger: "retention.renew", from: renewBefore, to: asset.governance.status,
    });
    // 续期可能把资产带回 Verified（重新进入召回），对齐向量索引
    await syncVectorsAfterTransition(embeddingSync, eventSink, {
      trigger: "retention.renew",
      assetKind: "memory",
      assetId: asset.id,
      scope: asset.scope,
    });
    send(response, 200, asset);
    return;
  }

  if (method === "GET" && !url.pathname.startsWith("/v1/") && webRoot && await serveWeb(response, webRoot, url.pathname)) return;

  send(response, 404, { error: "NOT_FOUND", message: "route not found" });
}

/**
 * 端点授权（Task 15/16）：动作授权 + 作用域边界 + 速率限制，顺序固定。
 * 失败时已写入响应并返回 false，路由据此终止：
 * - 动作/作用域被拒 → 403 并记 audit.denied；
 * - 作用域判定只认认证得到的 Principal，请求体自报的作用域越界即拒绝，
 *   缺失/非法作用域跳过边界检查，交由后续参数校验兜底；
 * - 授权通过后消耗限流配额（read 域 / write 域，review 与 write 共享高价值操作配额），
 *   超限 → 429。
 */
function authorize(
  principal: Principal,
  action: AuthAction,
  scope: Scope | undefined,
  path: string,
  response: ServerResponse,
  security?: { rateLimiter?: RateLimiter; audit?: AuditService },
): boolean {
  if (!canPerform(principal, action)) {
    security?.audit?.denied({ principal, path, code: "FORBIDDEN_ACTION", action });
    send(response, 403, {
      error: "FORBIDDEN_ACTION",
      message: `角色 ${principal.roles.join("/")} 不允许执行 ${action} 操作`,
    });
    return false;
  }
  if (scope !== undefined && typeof scope === "object" && !scopeAllowed(principal, scope)) {
    security?.audit?.denied({ principal, path, code: "FORBIDDEN_SCOPE", action });
    send(response, 403, { error: "FORBIDDEN_SCOPE", message: "请求作用域超出认证身份的边界" });
    return false;
  }
  if (security?.rateLimiter) {
    const verdict = security.rateLimiter.consume(action === "read" ? "read" : "write", principal.userId);
    if (!verdict.allowed) {
      sendRateLimited(response, verdict.retryAfterSeconds);
      return false;
    }
  }
  return true;
}

/** Draft 可见性属于审核能力：只有 review 及以上角色才能请求 includeDraft=true。 */
function draftVisible(principal: Principal, requested: boolean, response: ServerResponse): boolean {
  if (requested && !canPerform(principal, "review")) {
    send(response, 403, { error: "FORBIDDEN_ACTION", message: "Draft 资产仅对具备审核角色的身份可见" });
    return false;
  }
  return true;
}

/** 限流响应：429 + Retry-After，告知客户端窗口剩余等待时间。 */
function sendRateLimited(response: ServerResponse, retryAfterSeconds: number): void {
  const body = JSON.stringify({ error: "RATE_LIMITED", message: "请求频率超出限制，请稍后重试", retryAfterSeconds });
  response.writeHead(429, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "retry-after": String(retryAfterSeconds),
  });
  response.end(body);
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

/** 请求体硬上限（红线）：超过即 400 拒绝。 */
const MAX_REQUEST_BODY_BYTES = 1_000_000;

/** 读取并解析 JSON 请求体；空体视为 {}。字节上限与排空语义见 read-request-body.ts。 */
async function readJson(request: IncomingMessage): Promise<unknown> {
  const buffer = await readRequestBody(request, MAX_REQUEST_BODY_BYTES);
  if (buffer.length === 0) return {};
  return JSON.parse(buffer.toString("utf8"));
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
