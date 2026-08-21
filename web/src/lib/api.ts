export const LOCAL_SCOPE = { userId: "local-admin", teamId: "local", agentId: "default" } as const;

export type Status = "draft" | "verified" | "deprecated" | "rejected" | "archived";

export interface MemoryAsset {
  id: string;
  layer: "l1" | "l2" | "l3";
  scope: typeof LOCAL_SCOPE;
  content: string;
  governance: {
    status: Status;
    confidence: number;
    createdReason: string;
    createdAt: string;
    updatedAt: string;
    sensitivity: "normal" | "sensitive" | "restricted";
  };
  sources: Array<{ evidenceId: string; capturedAt: string }>;
}

export interface SkillDocument {
  id: string;
  scope: typeof LOCAL_SCOPE;
  name: string;
  description: string;
  content: string;
  version: number;
  status: Status;
  sources: Array<{ evidenceId: string; capturedAt: string }>;
  createdAt: string;
  updatedAt: string;
}

export interface EvidenceRecord {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  capturedAt: string;
}

/** Skill 历史版本（含被替换时的治理状态快照）。 */
export interface SkillVersionInfo {
  skillId: string;
  version: number;
  content: string;
  status: Status | null;
  createdAt: string;
}

/** 语义化版本差异条目：frontmatter 字段或正文章节的增删改。 */
export interface SkillDiffEntry {
  kind: "field" | "section";
  change: "added" | "removed" | "modified";
  target: string;
  before?: string;
  after?: string;
  addedLines?: string[];
  removedLines?: string[];
}

export interface SkillDiffResult {
  fromVersion: number | null;
  toVersion: number;
  entries: SkillDiffEntry[];
  summary: string;
}

export interface SkillValidationIssue {
  field: string;
  code: string;
  severity: "error" | "warning";
  message: string;
}

export interface SkillValidationReport {
  valid: boolean;
  issues: SkillValidationIssue[];
}

/** Skill 使用事件四分类。 */
export type SkillRunEventKind = "recalled" | "adopted" | "succeeded" | "failed";

export interface SkillRunSummary {
  skillId: string;
  version: number;
  runs: Record<SkillRunEventKind, number>;
  feedback: { useful: number; irrelevant: number; incorrect: number; outdated: number };
  verdict: "no-evidence" | "supported" | "mixed" | "contradicted";
  verdictLabel: string;
  hasEvidence: boolean;
}

/** 治理任务：同一作用域内重复或疑似冲突的资产对。 */
export interface GovernanceTask {
  id: string;
  kind: "duplicate" | "conflict";
  assetKind: "memory" | "skill";
  assetIds: string[];
  assets: Array<{ id: string; preview: string; name?: string }>;
  detail: string;
  suggestion: string;
}

export interface RetentionReviewItem {
  id: string;
  kind: "memory" | "skill";
  status: Status;
  preview: string;
  validUntil?: string;
  lastVerifiedAt?: string;
  updatedAt: string;
}

export interface RetentionReview {
  expiredMemories: RetentionReviewItem[];
  staleMemories: RetentionReviewItem[];
  staleSkills: RetentionReviewItem[];
  /** 超期未审的 Draft（memory + skill，仅提示，可由 archiveStaleDrafts 清扫）。 */
  staleDrafts: RetentionReviewItem[];
  generatedAt: string;
}

/** 删除证据前的只读影响预览。 */
export interface EvidenceDeletionImpact {
  evidence: { id: string; role: string; capturedAt: string; contentPreview: string };
  memories: Array<{ id: string; status: Status; contentPreview: string; wouldTransitionTo: Status | null }>;
  skills: Array<{ id: string; name: string; version: number; status: Status; wouldTransitionTo: Status | null }>;
  pendingReviewCount: number;
}

/** 提案 Job 报告（与后端 ProposalJobReport 对应）。 */
export interface ProposalRunReport<TCreated> {
  kind: "memory" | "skill";
  model: string;
  promptVersion: string;
  inputEvidenceIds: string[];
  created: TCreated[];
  rejected: Array<{ index: number; summary: string; reasons: string[] }>;
  attempts: number;
  latencyMs: number;
  /** 由用户预配的确定性规则自动 Verify 的资产 ID（服务端开启时非空）。 */
  autoVerifiedIds?: string[];
}

/** 显式反馈四分类：与后端 FEEDBACK_KINDS 对应。 */
export type FeedbackKind = "useful" | "irrelevant" | "incorrect" | "outdated";

interface ApiErrorBody { error?: string; message?: string }

export class ApiError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message);
    this.name = "ApiError";
  }
}

export async function login(accessKey: string): Promise<void> {
  const response = await fetch("/v1/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ accessKey }),
  });
  if (!response.ok) throw await toApiError(response);
}

export class ApiClient {
  constructor(
    private readonly accessKey: string,
    private readonly onUnauthorized: () => void = () => undefined,
  ) {}

  async listMemories(): Promise<MemoryAsset[]> {
    return (await this.request<{ items: MemoryAsset[] }>("/v1/memories/list", { scope: LOCAL_SCOPE })).items;
  }

  async createMemory(input: { evidence: string; content: string; layer: MemoryAsset["layer"]; confidence: number; reason: string }): Promise<void> {
    const evidenceId = crypto.randomUUID();
    await this.request("/v1/evidence", {
      id: evidenceId,
      scope: LOCAL_SCOPE,
      role: "user",
      content: input.evidence,
    });
    await this.request("/v1/memories", {
      id: crypto.randomUUID(),
      layer: input.layer,
      scope: LOCAL_SCOPE,
      content: input.content,
      confidence: input.confidence,
      reason: input.reason,
      sourceEvidenceIds: [evidenceId],
    });
  }

  async transitionMemory(id: string, target: Status): Promise<void> {
    await this.request(`/v1/memories/${encodeURIComponent(id)}/status`, { scope: LOCAL_SCOPE, target });
  }

  /** 批量取来源证据原文，供审核 Draft 时对照。 */
  async getEvidence(ids: string[]): Promise<EvidenceRecord[]> {
    return (await this.request<{ items: EvidenceRecord[] }>("/v1/evidence/get", { scope: LOCAL_SCOPE, ids })).items;
  }

  /** 人工触发的记忆提案：模型从最近证据提取候选，只产出 Draft。 */
  async runMemoryProposal(): Promise<ProposalRunReport<MemoryAsset>> {
    return this.request("/v1/proposals/memory/run", { scope: LOCAL_SCOPE });
  }

  /** 人工触发的 Skill 提案：模型从最近证据提取候选，只产出 Draft。 */
  async runSkillProposal(): Promise<ProposalRunReport<SkillDocument>> {
    return this.request("/v1/proposals/skill/run", { scope: LOCAL_SCOPE });
  }

  async listSkills(): Promise<SkillDocument[]> {
    return (await this.request<{ items: SkillDocument[] }>("/v1/skills/list", { scope: LOCAL_SCOPE })).items;
  }

  async createSkill(input: { name: string; description: string }): Promise<void> {
    const content = `---\nname: ${JSON.stringify(input.name)}\ndescription: ${JSON.stringify(input.description)}\n---\n\n# ${input.name}\n\n## When to use\n\nDescribe the trigger conditions.\n\n## Workflow\n\n1. Describe the first step.\n\n## Verification\n\nDescribe how to verify the result.\n`;
    await this.request("/v1/skills", {
      id: crypto.randomUUID(),
      scope: LOCAL_SCOPE,
      name: input.name,
      description: input.description,
      content,
      sourceEvidenceIds: [],
    });
  }

  async transitionSkill(id: string, target: Status): Promise<void> {
    await this.request(`/v1/skills/${encodeURIComponent(id)}/status`, { scope: LOCAL_SCOPE, target });
  }

  /** 版本历史（新版本在前）。 */
  async listSkillVersions(id: string): Promise<SkillVersionInfo[]> {
    return (await this.request<{ items: SkillVersionInfo[] }>(`/v1/skills/${encodeURIComponent(id)}/versions`, { scope: LOCAL_SCOPE })).items;
  }

  /** 语义化差异：默认对照最近已发布版本与当前版本。 */
  async skillDiff(id: string, options: { fromVersion?: number; toVersion?: number } = {}): Promise<SkillDiffResult> {
    return this.request(`/v1/skills/${encodeURIComponent(id)}/diff`, { scope: LOCAL_SCOPE, ...options });
  }

  /** 回滚到历史版本：追加为新 Draft，需要再次人工 Verify。 */
  async rollbackSkill(id: string, targetVersion: number): Promise<SkillDocument> {
    return this.request(`/v1/skills/${encodeURIComponent(id)}/rollback`, { scope: LOCAL_SCOPE, targetVersion });
  }

  /** 质量校验报告：error 级问题不建议 Verify。 */
  async validateSkill(id: string): Promise<SkillValidationReport> {
    return this.request(`/v1/skills/${encodeURIComponent(id)}/validate`, { scope: LOCAL_SCOPE });
  }

  /** 记录一次 Skill 使用事件（被召回/被采用/成功/失败）。 */
  async recordSkillRun(id: string, event: SkillRunEventKind, options: { requestId?: string; note?: string } = {}): Promise<void> {
    await this.request(`/v1/skills/${encodeURIComponent(id)}/runs`, { scope: LOCAL_SCOPE, event, ...options });
  }

  /** 使用效果汇总：只有落库的使用证据才支撑"有效"结论。 */
  async skillRunSummary(id: string): Promise<SkillRunSummary> {
    return this.request(`/v1/skills/${encodeURIComponent(id)}/run-summary`, { scope: LOCAL_SCOPE });
  }

  /** 冲突/重复治理任务（确定性扫描，处置资产后任务自动消失）。 */
  async listConflicts(): Promise<GovernanceTask[]> {
    return (await this.request<{ items: GovernanceTask[] }>("/v1/governance/conflicts", { scope: LOCAL_SCOPE })).items;
  }

  /** 过期与长期未验证的待复核清单（只读）。 */
  async retentionReview(): Promise<RetentionReview> {
    return this.request("/v1/governance/retention/review", { scope: LOCAL_SCOPE });
  }

  /** 把已过期的 Verified 记忆降权为待复核（Deprecated），不物理删除。 */
  async deprecateExpired(): Promise<{ memories: Array<{ id: string; from: Status; to: Status }> }> {
    return this.request("/v1/governance/retention/deprecate-expired", { scope: LOCAL_SCOPE });
  }

  /** 归档超期未审 Draft（memory + skill，默认 7 天），draft→archived，不物理删除。 */
  async archiveStaleDrafts(days?: number): Promise<{ memories: Array<{ id: string; from: Status; to: Status }>; skills: Array<{ id: string; from: Status; to: Status }> }> {
    return this.request("/v1/governance/drafts/archive-stale", days === undefined ? { scope: LOCAL_SCOPE } : { scope: LOCAL_SCOPE, days });
  }

  /** 续期记忆：延长有效期（ISO 日期）或传 null 清除期限；因过期降权的资产恢复 Verified。 */
  async renewMemory(id: string, validUntil: string | null): Promise<void> {
    await this.request(`/v1/governance/memories/${encodeURIComponent(id)}/renew`, { scope: LOCAL_SCOPE, validUntil });
  }

  /** 删除证据前的只读影响预览。 */
  async evidenceImpact(id: string): Promise<EvidenceDeletionImpact> {
    return this.request(`/v1/evidence/${encodeURIComponent(id)}/impact`, { scope: LOCAL_SCOPE });
  }

  /** 提交显式反馈：只采集人工判断，不改写资产内容；incorrect/outdated 命中 auto-verified 记忆时服务端自动降级待复核。 */
  async submitFeedback(input: { assetKind: "memory" | "skill"; assetId: string; kind: FeedbackKind; comment?: string }): Promise<void> {
    await this.request("/v1/feedback", { ...input, scope: LOCAL_SCOPE });
  }

  private async request<T = unknown>(path: string, body: unknown): Promise<T> {
    const response = await fetch(path, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.accessKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      if (response.status === 401) this.onUnauthorized();
      throw await toApiError(response);
    }
    return await response.json() as T;
  }
}

async function toApiError(response: Response): Promise<ApiError> {
  const body = await response.json().catch(() => ({})) as ApiErrorBody;
  return new ApiError(response.status, body.error ?? "REQUEST_FAILED", body.message ?? "请求失败");
}
