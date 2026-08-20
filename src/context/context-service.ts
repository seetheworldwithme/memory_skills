import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

import type { MemoryService } from "../memory/memory-service.js";
import type { SkillService } from "../skills/skill-service.js";
import { lexicalScore, matchedQueryTerms } from "../retrieval/text-match.js";
import type { EventSink } from "../observability/event-sink.js";
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

export class ContextService {
  private readonly eventSink: EventSink | undefined;
  private readonly now: () => number;

  constructor(
    private readonly memory: MemoryService,
    private readonly skills: SkillService,
    private readonly newRequestId: () => string = randomUUID,
    observability: ContextObservability = {},
  ) {
    this.eventSink = observability.eventSink;
    this.now = observability.now ?? (() => performance.now());
  }

  recall(input: ContextRecallInput): ContextRecallResponse {
    const requestId = this.newRequestId();
    const startedAt = this.now();
    try {
      const { response, memoryCandidates, skillCandidates } = this.recallInternal(input, requestId);
      this.emitCompleted(input, response, memoryCandidates, skillCandidates, startedAt);
      return response;
    } catch (error) {
      this.emitFailed(input, requestId, startedAt, error);
      throw error;
    }
  }

  /** 候选计数随响应一起返回，供诊断事件区分"候选数"和"最终返回数"。 */
  private recallInternal(input: ContextRecallInput, requestId: string): {
    response: ContextRecallResponse;
    memoryCandidates: number;
    skillCandidates: number;
  } {
    const maxMemoryResults = positiveInteger(input.maxMemoryResults ?? 5, "maxMemoryResults");
    const maxMemoryChars = positiveInteger(input.maxMemoryChars ?? 4_000, "maxMemoryChars");
    const maxSkillResults = positiveInteger(input.maxSkillResults ?? 3, "maxSkillResults");
    const maxSkillChars = positiveInteger(input.maxSkillChars ?? 8_000, "maxSkillChars");

    const rankedMemories = this.memory.recallRanked({
      query: input.query,
      scope: input.scope,
      ...(input.includeDraft === undefined ? {} : { includeDraft: input.includeDraft }),
      maxResults: maxMemoryResults * RESULT_HEADROOM,
      maxTotalChars: Number.MAX_SAFE_INTEGER,
    });
    const warnings: ContractWarning[] = [];
    const droppedMemories = rankedMemories.length - Math.min(rankedMemories.length, maxMemoryResults);
    const topMemories = rankedMemories.slice(0, maxMemoryResults);

    let usedMemoryChars = 0;
    let memoryTruncated = false;
    const memories: ContractedMemory[] = [];
    for (const memory of topMemories) {
      if (usedMemoryChars >= maxMemoryChars) break;
      const room = maxMemoryChars - usedMemoryChars;
      const content = memory.content.length > room ? memory.content.slice(0, room) : memory.content;
      const truncated = content.length < memory.content.length;
      memoryTruncated ||= truncated;
      usedMemoryChars += content.length;
      memories.push({ ...memory, content, truncated, match: lexicalMatch(input.query, memory.content, memory.score) });
    }

    const matchedSkills = this.skills.searchRanked(input.query, input.scope, input.includeDraft);
    const droppedSkills = matchedSkills.length - Math.min(matchedSkills.length, maxSkillResults);
    const topSkills = matchedSkills.slice(0, maxSkillResults);

    let usedSkillChars = 0;
    let skillTruncated = false;
    const skills: ContractedSkill[] = [];
    for (const skill of topSkills) {
      if (usedSkillChars >= maxSkillChars) break;
      const room = maxSkillChars - usedSkillChars;
      const content = skill.content.length > room ? skill.content.slice(0, room) : skill.content;
      const truncated = content.length < skill.content.length;
      skillTruncated ||= truncated;
      usedSkillChars += content.length;
      skills.push({ ...skill, content, truncated, match: lexicalMatch(input.query, skillSearchText(skill), lexicalScore(input.query, skillSearchText(skill))) });
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
      skillCandidates: matchedSkills.length,
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
 * MemoryService.recallRanked 在应用字符预算前就按 maxResults 截断，
 * 因此这里多取一倍余量，用于区分"按条数丢弃"和"按字符预算截断"。
 */
const RESULT_HEADROOM = 2;

function lexicalMatch(query: string, content: string, score: number): MatchMetadata {
  return {
    strategy: "lexical",
    score: Number(score.toFixed(4)),
    matchedTerms: matchedQueryTerms(query, content),
  };
}

function skillSearchText(skill: { name: string; description: string; content: string }): string {
  return `${skill.name} ${skill.description} ${skill.content}`;
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${field} must be a positive integer`);
  return value;
}

function roundDuration(durationMs: number): number {
  return Number(durationMs.toFixed(3));
}
