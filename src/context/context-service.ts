import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

import type { MemoryService } from "../memory/memory-service.js";
import type { SkillService } from "../skills/skill-service.js";
import type { EventSink } from "../observability/event-sink.js";
import { LexicalRetriever } from "../retrieval/lexical-retriever.js";
import {
  memorySearchText,
  skillSearchText,
  type RetrievableDocument,
  type Retriever,
  type ScoredCandidate,
} from "../retrieval/types.js";
import {
  EVENT_SCHEMA_VERSION,
  errorCodeFor,
  type ContextRecallCompletedEvent,
  type ContextRecallFailedEvent,
} from "../observability/events.js";
import type { ContextRecallInput } from "./types.js";
import {
  CONTRACT_VERSION,
  type ContractWarning,
  type ContractedMemory,
  type ContractedSkill,
  type ContextBudgetReport,
  type ContextRecallResponse,
  type MatchMetadata,
} from "./contract.js";

/** 可观测性注入项：事件输出与计时函数均可替换，便于测试。 */
export interface ContextObservability {
  eventSink?: EventSink;
  now?: () => number;
}

/** 检索注入项：默认词法；混合检索通过注入 HybridRetriever 启用。 */
export interface ContextRetrievalOptions {
  retriever?: Retriever;
}

export class ContextService {
  private readonly eventSink: EventSink | undefined;
  private readonly now: () => number;
  private readonly retriever: Retriever;
  private readonly newRequestId: () => string;

  constructor(
    private readonly memory: MemoryService,
    private readonly skills: SkillService,
    newRequestId: () => string = randomUUID,
    observability: ContextObservability = {},
    retrieval: ContextRetrievalOptions = {},
  ) {
    this.eventSink = observability.eventSink;
    this.now = observability.now ?? (() => performance.now());
    this.retriever = retrieval.retriever ?? new LexicalRetriever();
    this.newRequestId = newRequestId;
  }

  /**
   * 召回是异步接口：混合检索的查询向量需要一次 Embedding 网络调用；
   * 词法路径同样走异步签名，保证评测与生产行为一致。
   * 向量通道故障时由 Retriever 降级为词法，召回本身不会失败。
   */
  async recall(input: ContextRecallInput): Promise<ContextRecallResponse> {
    const requestId = this.newRequestId();
    const startedAt = this.now();
    try {
      const { response, memoryCandidates, skillCandidates } = await this.recallInternal(input, requestId);
      this.emitCompleted(input, response, memoryCandidates, skillCandidates, startedAt);
      return response;
    } catch (error) {
      this.emitFailed(input, requestId, startedAt, error);
      throw error;
    }
  }

  /** 候选计数随响应一起返回，供诊断事件区分"候选数"和"最终返回数"。 */
  private async recallInternal(input: ContextRecallInput, requestId: string): Promise<{
    response: ContextRecallResponse;
    memoryCandidates: number;
    skillCandidates: number;
  }> {
    const maxMemoryResults = positiveInteger(input.maxMemoryResults ?? 5, "maxMemoryResults");
    const maxMemoryChars = positiveInteger(input.maxMemoryChars ?? 4_000, "maxMemoryChars");
    const maxSkillResults = positiveInteger(input.maxSkillResults ?? 3, "maxSkillResults");
    const maxSkillChars = positiveInteger(input.maxSkillChars ?? 8_000, "maxSkillChars");

    // 候选来自作用域与治理过滤后的可召回资产，排序交给 Retriever：
    // ContextService 不感知词法/向量实现，也不感知厂商与存储
    const memoryAssets = this.memory.listRecallable(input.scope, input.includeDraft === true);
    const memoryRank = await this.retriever.rank(
      input.query,
      memoryAssets.map((asset): RetrievableDocument => ({
        kind: "memory",
        id: asset.id,
        text: memorySearchText(asset),
        weight: asset.governance.confidence,
      })),
      { scope: input.scope, kind: "memory", limit: maxMemoryResults * RESULT_HEADROOM },
    );
    const memoryById = new Map(memoryAssets.map((asset) => [asset.id, asset]));
    const rankedMemories = memoryRank.candidates
      .map((candidate) => ({ asset: memoryById.get(candidate.id), candidate }))
      .filter((entry): entry is { asset: NonNullable<typeof entry.asset>; candidate: ScoredCandidate } =>
        entry.asset !== undefined);

    const warnings: ContractWarning[] = [];
    const droppedMemories = rankedMemories.length - Math.min(rankedMemories.length, maxMemoryResults);
    const topMemories = rankedMemories.slice(0, maxMemoryResults);

    let usedMemoryChars = 0;
    let memoryTruncated = false;
    const memories: ContractedMemory[] = [];
    for (const { asset, candidate } of topMemories) {
      if (usedMemoryChars >= maxMemoryChars) break;
      const room = maxMemoryChars - usedMemoryChars;
      const content = asset.content.length > room ? asset.content.slice(0, room) : asset.content;
      const truncated = content.length < asset.content.length;
      memoryTruncated ||= truncated;
      usedMemoryChars += content.length;
      memories.push({ ...asset, content, truncated, score: candidate.score, match: toMatchMetadata(candidate) });
    }

    const skillAssets = this.skills.listRecallable(input.scope, input.includeDraft === true);
    const skillRank = await this.retriever.rank(
      input.query,
      skillAssets.map((skill): RetrievableDocument => ({
        kind: "skill",
        id: skill.id,
        text: skillSearchText(skill),
        weight: 1,
      })),
      // 沿用既有语义：Skill 不在检索层截断，由预算层统一裁剪
      { scope: input.scope, kind: "skill" },
    );
    const skillById = new Map(skillAssets.map((skill) => [skill.id, skill]));
    const rankedSkills = skillRank.candidates
      .map((candidate) => ({ skill: skillById.get(candidate.id), candidate }))
      .filter((entry): entry is { skill: NonNullable<typeof entry.skill>; candidate: ScoredCandidate } =>
        entry.skill !== undefined);

    if (memoryRank.vectorDegraded || skillRank.vectorDegraded) {
      warnings.push({
        code: "RETRIEVAL_DEGRADED_LEXICAL",
        message: "vector retrieval failed; results degraded to lexical ranking",
      });
    }
    const droppedSkills = rankedSkills.length - Math.min(rankedSkills.length, maxSkillResults);
    const topSkills = rankedSkills.slice(0, maxSkillResults);

    let usedSkillChars = 0;
    let skillTruncated = false;
    const skills: ContractedSkill[] = [];
    for (const { skill, candidate } of topSkills) {
      if (usedSkillChars >= maxSkillChars) break;
      const room = maxSkillChars - usedSkillChars;
      const content = skill.content.length > room ? skill.content.slice(0, room) : skill.content;
      const truncated = content.length < skill.content.length;
      skillTruncated ||= truncated;
      usedSkillChars += content.length;
      skills.push({ ...skill, content, truncated, match: toMatchMetadata(candidate) });
    }

    if (memoryTruncated) {
      warnings.push({ code: "MEMORY_BUDGET_TRUNCATED", message: "memory results were truncated to fit maxMemoryChars" });
    }
    if (skillTruncated) {
      warnings.push({ code: "SKILL_BUDGET_TRUNCATED", message: "skill results were truncated to fit maxSkillChars" });
    }
    if (droppedMemories > 0) {
      warnings.push({ code: "MEMORY_RESULTS_DROPPED", message: `${droppedMemories} matching memories exceeded maxMemoryResults` });
    }
    if (droppedSkills > 0) {
      warnings.push({ code: "SKILL_RESULTS_DROPPED", message: `${droppedSkills} matching skills exceeded maxSkillResults` });
    }

    const budget: ContextBudgetReport = {
      maxMemoryResults,
      maxMemoryChars,
      maxSkillResults,
      maxSkillChars,
      usedMemoryChars,
      usedSkillChars,
    };

    return {
      response: {
        contractVersion: CONTRACT_VERSION,
        requestId,
        query: input.query,
        scope: input.scope,
        memories,
        skills,
        budget,
        truncated: memoryTruncated || skillTruncated,
        warnings,
      },
      memoryCandidates: rankedMemories.length,
      skillCandidates: rankedSkills.length,
    };
  }

  /** 召回成功事件：只携带计数、预算、策略与耗时，不携带任何正文。 */
  private emitCompleted(
    input: ContextRecallInput,
    response: ContextRecallResponse,
    memoryCandidates: number,
    skillCandidates: number,
    startedAt: number,
  ): void {
    if (!this.eventSink) return;
    const strategies = new Set<string>();
    for (const memory of response.memories) strategies.add(memory.match.strategy);
    for (const skill of response.skills) strategies.add(skill.match.strategy);
    const event: ContextRecallCompletedEvent = {
      schemaVersion: EVENT_SCHEMA_VERSION,
      eventType: "context.recall.completed",
      timestamp: new Date().toISOString(),
      requestId: response.requestId,
      contractVersion: response.contractVersion,
      retrievalStrategy: this.retriever.strategy,
      scope: input.scope,
      durationMs: roundDuration(this.now() - startedAt),
      queryChars: input.query.length,
      includeDraft: input.includeDraft === true,
      memoryCandidates,
      memoryReturned: response.memories.length,
      maxMemoryResults: response.budget.maxMemoryResults,
      maxMemoryChars: response.budget.maxMemoryChars,
      usedMemoryChars: response.budget.usedMemoryChars,
      skillCandidates,
      skillReturned: response.skills.length,
      maxSkillResults: response.budget.maxSkillResults,
      maxSkillChars: response.budget.maxSkillChars,
      usedSkillChars: response.budget.usedSkillChars,
      truncated: response.truncated,
      warningCodes: response.warnings.map((warning) => warning.code),
      matchStrategies: [...strategies],
    };
    this.eventSink.emit(event);
  }

  /** 召回失败事件：只携带错误码与错误名，避免错误消息拼接用户内容。 */
  private emitFailed(input: ContextRecallInput, requestId: string, startedAt: number, error: unknown): void {
    if (!this.eventSink) return;
    const event: ContextRecallFailedEvent = {
      schemaVersion: EVENT_SCHEMA_VERSION,
      eventType: "context.recall.failed",
      timestamp: new Date().toISOString(),
      requestId,
      scope: input.scope,
      durationMs: roundDuration(this.now() - startedAt),
      queryChars: input.query.length,
      errorCode: errorCodeFor(error),
      errorName: error instanceof Error ? error.name : "UnknownError",
    };
    this.eventSink.emit(event);
  }
}

/**
 * MemoryService 侧候选在应用字符预算前就按 limit 截断，
 * 因此这里多取一倍余量，用于区分"按条数丢弃"和"按字符预算截断"。
 */
const RESULT_HEADROOM = 2;

function toMatchMetadata(candidate: ScoredCandidate): MatchMetadata {
  return {
    strategy: candidate.strategy,
    score: Number(candidate.score.toFixed(4)),
    matchedTerms: candidate.matchedTerms,
  };
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${field} must be a positive integer`);
  return value;
}

function roundDuration(durationMs: number): number {
  return Number(durationMs.toFixed(3));
}
