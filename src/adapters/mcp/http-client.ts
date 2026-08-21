import type { ContextRecallInput } from "../../context/types.js";
import type { ContextRecallResponse } from "../../context/contract.js";
import type { Scope } from "../../governance/types.js";
import type { RecalledMemory } from "../../memory/types.js";
import type { SkillDocument } from "../../skills/types.js";

interface ClientOptions {
  baseUrl: string;
  accessKey: string;
  fetch?: typeof globalThis.fetch;
}

type Environment = Record<string, string | undefined>;

export class MemorySkillsHttpClient {
  private readonly baseUrl: string;
  private readonly accessKey: string;
  private readonly fetch: typeof globalThis.fetch;

  constructor(options: ClientOptions) {
    if (!options.baseUrl.trim()) throw new Error("baseUrl must not be empty");
    if (!options.accessKey.trim()) throw new Error("accessKey must not be empty");
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.accessKey = options.accessKey;
    this.fetch = options.fetch ?? globalThis.fetch;
  }

  static fromEnv(environment: Environment = process.env): MemorySkillsHttpClient {
    const baseUrl = environment.MEMORY_SKILLS_URL?.trim();
    if (!baseUrl) throw new Error("MEMORY_SKILLS_URL is required for the MCP adapter");
    // 团队模式：优先使用显式认证 Token（通常签发为 reader，Agent 天然无法越权写入）；
    // 未配置时回落本地 Access Key（admin，仅限本地单人模式）
    const token = environment.MEMORY_SKILLS_AUTH_TOKEN?.trim() || environment.MEMORY_SKILLS_ACCESS_KEY?.trim();
    if (!token) {
      throw new Error("MEMORY_SKILLS_AUTH_TOKEN or MEMORY_SKILLS_ACCESS_KEY is required for the MCP adapter");
    }
    return new MemorySkillsHttpClient({ baseUrl, accessKey: token });
  }

  recallContext(input: ContextRecallInput): Promise<ContextRecallResponse> {
    return this.post("/v1/context/recall", input);
  }

  recallMemory(input: {
    query: string;
    scope: Scope;
    includeDraft?: boolean;
    maxResults?: number;
    maxTotalChars?: number;
  }): Promise<{ items: RecalledMemory[] }> {
    return this.post("/v1/recall", input);
  }

  searchSkills(input: { query: string; scope: Scope; includeDraft?: boolean }): Promise<{ items: SkillDocument[] }> {
    return this.post("/v1/skills/search", input);
  }

  getSkill(id: string, scope: Scope): Promise<SkillDocument> {
    return this.post("/v1/skills/get", { id, scope });
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const response = await this.fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.accessKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      throw new Error(`Memory Skills HTTP ${response.status}: invalid JSON response`);
    }
    if (!response.ok) {
      const message = isErrorResponse(parsed) ? parsed.message : response.statusText;
      throw new Error(`Memory Skills HTTP ${response.status}: ${message}`);
    }
    return parsed as T;
  }
}

function isErrorResponse(value: unknown): value is { message: string } {
  return typeof value === "object" && value !== null
    && "message" in value && typeof value.message === "string";
}
