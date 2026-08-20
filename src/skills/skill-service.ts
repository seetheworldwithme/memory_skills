import { transitionStatus, type GovernedStatus } from "../governance/lifecycle.js";
import type { Scope, SourceReference } from "../governance/types.js";
import type { SqliteRepository } from "../storage/sqlite-repository.js";
import type { SkillDocument } from "./types.js";
import { parseDocument } from "yaml";
import { NotFoundError } from "../errors.js";
import { hasLexicalMatch, lexicalScore } from "../retrieval/text-match.js";

export class SkillVersionConflictError extends Error {
  constructor(id: string, expected: number) {
    super(`skill ${id} is not at expected version ${expected}`);
    this.name = "SkillVersionConflictError";
  }
}

export class SkillService {
  constructor(
    private readonly repository: SqliteRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  create(input: {
    id: string;
    scope: Scope;
    name: string;
    description: string;
    content: string;
    sourceEvidenceIds: string[];
  }): SkillDocument {
    validateSkillContent(input.name, input.description, input.content);
    const sources: SourceReference[] = input.sourceEvidenceIds.map((evidenceId) => {
      const evidence = this.repository.getEvidenceScoped(evidenceId, input.scope);
      if (!evidence) throw new Error(`source evidence not found in scope: ${evidenceId}`);
      return { evidenceId, capturedAt: evidence.capturedAt };
    });
    const now = this.now().toISOString();
    return this.repository.insertSkill({
      id: input.id,
      scope: input.scope,
      name: input.name,
      description: input.description,
      content: input.content,
      version: 1,
      status: "draft",
      sources,
      createdAt: now,
      updatedAt: now,
    });
  }

  get(id: string, scope: Scope): SkillDocument | undefined {
    const skill = this.repository.getSkill(id);
    return skill && sameScope(skill.scope, scope) ? skill : undefined;
  }

  list(scope: Scope): SkillDocument[] {
    return this.repository.listSkills(scope);
  }

  update(input: {
    id: string;
    scope: Scope;
    expectedVersion: number;
    content: string;
    sourceEvidenceIds: string[];
  }): SkillDocument {
    const current = this.repository.getSkill(input.id);
    if (!current || !sameScope(current.scope, input.scope)) throw new NotFoundError(`skill not found: ${input.id}`);
    if (current.status === "archived" || current.status === "rejected") {
      throw new Error(`cannot update ${current.status} skill; create a new candidate instead`);
    }
    validateSkillContent(current.name, current.description, input.content);
    const sources: SourceReference[] = input.sourceEvidenceIds.map((evidenceId) => {
      const evidence = this.repository.getEvidenceScoped(evidenceId, input.scope);
      if (!evidence) throw new Error(`source evidence not found in scope: ${evidenceId}`);
      return { evidenceId, capturedAt: evidence.capturedAt };
    });
    const updated = this.repository.appendSkillVersion(
      input.id,
      input.expectedVersion,
      input.content,
      sources,
      this.now().toISOString(),
    );
    if (!updated) throw new SkillVersionConflictError(input.id, input.expectedVersion);
    return updated;
  }

  transition(id: string, scope: Scope, target: GovernedStatus): SkillDocument {
    const skill = this.repository.getSkill(id);
    if (!skill || !sameScope(skill.scope, scope)) throw new NotFoundError(`skill not found: ${id}`);
    return this.repository.updateSkillStatus(
      id,
      transitionStatus(skill.status, target),
      this.now().toISOString(),
    );
  }

  search(query: string, scope: Scope, includeDraft = false): SkillDocument[] {
    if (!query.trim()) throw new Error("query must not be empty");
    return this.repository.listSkills(scope)
      .filter((skill) => skill.status === "verified" || (includeDraft && skill.status === "draft"))
      .filter((skill) => {
        const text = `${skill.name} ${skill.description} ${skill.content}`;
        return hasLexicalMatch(query, text);
      });
  }

  /**
   * 带相关性排序的搜索，让 ContextService 能像处理记忆一样
   * 对 Skill 结果做排序与预算控制。
   */
  searchRanked(query: string, scope: Scope, includeDraft = false): SkillDocument[] {
    if (!query.trim()) throw new Error("query must not be empty");
    return this.listRecallable(scope, includeDraft)
      .map((skill) => {
        const text = `${skill.name} ${skill.description} ${skill.content}`;
        return { skill, score: lexicalScore(query, text) };
      })
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score)
      .map(({ skill }) => skill);
  }

  /**
   * 作用域与状态过滤后的可召回 Skill（不打分）：
   * 与 MemoryService.listRecallable 对齐，作为检索层的统一候选来源。
   */
  listRecallable(scope: Scope, includeDraft = false): SkillDocument[] {
    return this.repository.listSkills(scope)
      .filter((skill) => skill.status === "verified" || (includeDraft && skill.status === "draft"));
  }
}

function validateSkillContent(name: string, description: string, content: string): void {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) throw new Error("invalid skill name");
  if (!description.trim()) throw new Error("skill description must not be empty");
  const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!frontmatter) throw new Error("SKILL.md frontmatter is required");
  const document = parseDocument(frontmatter[1]!, { uniqueKeys: true });
  if (document.errors.length > 0) throw new Error(`invalid SKILL.md frontmatter: ${document.errors[0]!.message}`);
  const header = document.toJS() as { name?: unknown; description?: unknown } | null;
  if (!header || typeof header !== "object") throw new Error("SKILL.md frontmatter must be a mapping");
  if (header.name !== name) {
    throw new Error("SKILL.md frontmatter name must match skill name");
  }
  if (typeof header.description !== "string" || !header.description.trim()) {
    throw new Error("SKILL.md frontmatter description must not be empty");
  }
  if (header.description !== description) {
    throw new Error("SKILL.md frontmatter description must match skill description");
  }
}

function sameScope(a: Scope, b: Scope): boolean {
  return a.userId === b.userId
    && a.teamId === b.teamId
    && a.agentId === b.agentId
    && (a.sessionId ?? null) === (b.sessionId ?? null);
}
