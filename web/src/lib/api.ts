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

  /** 提交显式反馈：只采集人工判断，不会自动改写资产。 */
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
