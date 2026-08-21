import { randomUUID } from "node:crypto";

import { NotFoundError } from "../errors.js";
import type { LlmProvider } from "../llm/types.js";
import type { Scope } from "../governance/types.js";
import type { MemoryService } from "../memory/memory-service.js";
import type { Evidence, MemoryAsset } from "../memory/types.js";
import type { SkillService } from "../skills/skill-service.js";
import type { SkillDocument } from "../skills/types.js";
import type { SqliteRepository } from "../storage/sqlite-repository.js";
import type { ProposalJobInput, ProposalJobReport, RejectedCandidate } from "./interfaces.js";
import {
  MEMORY_EXTRACTION_PROMPT,
  SKILL_EXTRACTION_PROMPT,
  type MemoryCandidate,
  type SkillCandidate,
} from "./prompt-registry.js";
import { isDuplicateContent, normalizeForDedup, validateMemoryCandidate, validateSkillCandidate } from "./validators.js";

/** 每条证据正文送入模型前的截断长度（钩子按 1800 字分块存证，对齐此预算可整块进模型）。 */
const MAX_EVIDENCE_CHARS = 2_000;
/** 全部证据拼接后的总字符预算（2026-08-21 全量捕获后从 24K 放大，容纳长会话的分块证据）。 */
const MAX_TOTAL_EVIDENCE_CHARS = 48_000;
/** 未显式指定证据时默认取最近多少条（同上放大：长会话单次即可产出数十块证据）。 */
const DEFAULT_MAX_EVIDENCE = 50;

/**
 * Evidence 到 Draft 的提案流水线（人工触发）。
 * 治理约束：无论模型输出什么，这里只创建 Draft，绝不直接产生 Verified 资产；
 * 发布永远由 GovernanceService（人工 Verify/Reject）完成。
 * 单条候选失败只影响该候选（转为 rejected），不产生半写入资产。
 */
export class ProposalService {
  constructor(private readonly deps: {
    memory: MemoryService;
    skills: SkillService;
    repository: SqliteRepository;
    provider: LlmProvider;
    now?: () => Date;
    generateId?: () => string;
  }) {}

  async runMemoryProposal(input: ProposalJobInput): Promise<ProposalJobReport<MemoryAsset>> {
    const prompt = MEMORY_EXTRACTION_PROMPT;
    const evidence = this.selectEvidence(input);
    const startedAt = Date.now();
    if (evidence.length === 0) return emptyReport("memory", prompt.promptVersion);

    const response = await this.deps.provider.structured({
      task: prompt.task,
      systemPrompt: prompt.systemPrompt,
      userContent: renderEvidenceList(evidence),
      schemaName: prompt.schemaName,
      schema: prompt.schema,
    });

    const idByRef = evidenceIdByRef(evidence);
    const seen = new Set<string>();
    for (const asset of this.deps.memory.list(input.scope)) {
      if (asset.governance.status === "draft" || asset.governance.status === "verified") {
        seen.add(normalizeForDedup(asset.content));
      }
    }

    const created: MemoryAsset[] = [];
    const rejected: RejectedCandidate[] = [];
    for (const [index, candidate] of response.data.candidates.entries()) {
      const sourceEvidenceIds = resolveEvidenceIds(candidate.evidenceRefs, idByRef);
      const reasons = validateMemoryCandidate(candidate);
      if (reasons.length === 0 && sourceEvidenceIds.length === 0) reasons.push("证据引用编号无效");
      if (reasons.length === 0 && isDuplicateContent(candidate.content, seen)) reasons.push("与现有或同批候选重复");
      if (reasons.length > 0) {
        rejected.push(rejection(index, candidate.content, reasons));
        continue;
      }
      try {
        created.push(this.deps.memory.propose({
          id: this.nextId(),
          layer: candidate.layer,
          scope: input.scope,
          content: candidate.content.trim(),
          confidence: candidate.confidence,
          reason: candidate.reason.trim(),
          sourceEvidenceIds,
        }));
        seen.add(normalizeForDedup(candidate.content));
      } catch (error) {
        rejected.push(rejection(index, candidate.content, [`创建 Draft 失败：${errorMessage(error)}`]));
      }
    }

    return {
      kind: "memory",
      model: response.model,
      promptVersion: prompt.promptVersion,
      inputEvidenceIds: evidence.map((item) => item.id),
      created,
      rejected,
      usage: response.usage,
      attempts: response.attempts,
      latencyMs: Date.now() - startedAt,
    };
  }

  async runSkillProposal(input: ProposalJobInput): Promise<ProposalJobReport<SkillDocument>> {
    const prompt = SKILL_EXTRACTION_PROMPT;
    const evidence = this.selectEvidence(input);
    const startedAt = Date.now();
    if (evidence.length === 0) return emptyReport("skill", prompt.promptVersion);

    const response = await this.deps.provider.structured({
      task: prompt.task,
      systemPrompt: prompt.systemPrompt,
      userContent: renderEvidenceList(evidence),
      schemaName: prompt.schemaName,
      schema: prompt.schema,
    });

    const idByRef = evidenceIdByRef(evidence);
    const seen = new Set<string>();
    for (const skill of this.deps.skills.list(input.scope)) {
      if (skill.status === "draft" || skill.status === "verified") {
        seen.add(normalizeForDedup(skill.content));
      }
    }

    const created: SkillDocument[] = [];
    const rejected: RejectedCandidate[] = [];
    for (const [index, candidate] of response.data.candidates.entries()) {
      const sourceEvidenceIds = resolveEvidenceIds(candidate.evidenceRefs, idByRef);
      const reasons = validateSkillCandidate(candidate);
      if (reasons.length === 0 && sourceEvidenceIds.length === 0) reasons.push("证据引用编号无效");
      if (reasons.length === 0 && isDuplicateContent(candidate.content, seen)) reasons.push("与现有或同批候选重复");
      if (reasons.length > 0) {
        rejected.push(rejection(index, `${candidate.name}: ${candidate.description}`, reasons));
        continue;
      }
      try {
        created.push(this.deps.skills.create({
          id: this.nextId(),
          scope: input.scope,
          name: candidate.name,
          description: candidate.description.trim(),
          content: candidate.content.trim(),
          sourceEvidenceIds,
        }));
        seen.add(normalizeForDedup(candidate.content));
      } catch (error) {
        rejected.push(rejection(index, `${candidate.name}: ${candidate.description}`, [`创建 Draft 失败：${errorMessage(error)}`]));
      }
    }

    return {
      kind: "skill",
      model: response.model,
      promptVersion: prompt.promptVersion,
      inputEvidenceIds: evidence.map((item) => item.id),
      created,
      rejected,
      usage: response.usage,
      attempts: response.attempts,
      latencyMs: Date.now() - startedAt,
    };
  }

  /** 选择证据：显式 ID 逐个校验（缺失即失败），否则取该作用域最近一批。 */
  private selectEvidence(input: ProposalJobInput): Evidence[] {
    if (input.evidenceIds && input.evidenceIds.length > 0) {
      return input.evidenceIds.map((id) => {
        const evidence = this.deps.repository.getEvidenceScoped(id, input.scope);
        if (!evidence) throw new NotFoundError(`evidence not found in scope: ${id}`);
        return evidence;
      });
    }
    return this.deps.repository.listEvidence(input.scope, input.maxEvidence ?? DEFAULT_MAX_EVIDENCE);
  }

  private nextId(): string {
    return (this.deps.generateId ?? randomUUID)();
  }
}

/** 证据编号（从 1 开始）到真实 ID 的映射；模型只允许引用这些编号。 */
function evidenceIdByRef(evidence: readonly Evidence[]): Map<number, string> {
  return new Map(evidence.map((item, index) => [index + 1, item.id]));
}

/** 把模型给出的编号映射回真实证据 ID：过滤无效编号、去重并保持稳定顺序。 */
function resolveEvidenceIds(refs: readonly number[], idByRef: ReadonlyMap<number, string>): string[] {
  const ids: string[] = [];
  for (const ref of [...refs].sort((a, b) => a - b)) {
    const id = idByRef.get(ref);
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/** 组装发给模型的证据列表：编号 + 角色 + 时间 + 正文（超限截断）。 */
function renderEvidenceList(evidence: readonly Evidence[]): string {
  const lines: string[] = ["以下是编号后的对话证据（evidenceRefs 只能引用这些编号）："];
  let total = 0;
  for (const [index, item] of evidence.entries()) {
    const content = item.content.length > MAX_EVIDENCE_CHARS ? `${item.content.slice(0, MAX_EVIDENCE_CHARS)}…` : item.content;
    const block = `[#${index + 1}] ${item.role} · ${item.capturedAt}\n${content}`;
    if (total + block.length > MAX_TOTAL_EVIDENCE_CHARS) break;
    total += block.length;
    lines.push(block);
  }
  return lines.join("\n\n");
}

function rejection(index: number, rawSummary: string, reasons: string[]): RejectedCandidate {
  return { index: index + 1, summary: rawSummary.replace(/\s+/g, " ").trim().slice(0, 80), reasons };
}

function emptyReport<TCreated>(kind: "memory" | "skill", promptVersion: string): ProposalJobReport<TCreated> {
  return {
    kind,
    model: "",
    promptVersion,
    inputEvidenceIds: [],
    created: [],
    rejected: [],
    usage: {},
    attempts: 0,
    latencyMs: 0,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
