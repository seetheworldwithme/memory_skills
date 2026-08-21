import { transitionStatus, type GovernedStatus } from "../governance/lifecycle.js";
import type { Scope, SourceReference } from "../governance/types.js";
import type { SqliteRepository } from "../storage/sqlite-repository.js";
import type { SkillDocument, SkillVersionRecord } from "./types.js";
import { parseDocument } from "yaml";
import { NotFoundError } from "../errors.js";
import { hasLexicalMatch, lexicalScore } from "../retrieval/text-match.js";
import { containsSensitiveContent } from "../extraction/validators.js";
import { validateSkillDocument, type SkillValidationReport } from "./skill-validator.js";
import { diffSkillMarkdown, emptySkillDiff, type SkillDiffResult } from "./skill-diff.js";
import {
  SkillRunRecorder,
  type SkillRunRecord,
  type SkillRunSummary,
} from "./skill-run-record.js";

export class SkillVersionConflictError extends Error {
  constructor(id: string, expected: number) {
    super(`skill ${id} is not at expected version ${expected}`);
    this.name = "SkillVersionConflictError";
  }
}

export class SkillService {
  private readonly runs: SkillRunRecorder;

  constructor(
    private readonly repository: SqliteRepository,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.runs = new SkillRunRecorder(repository, now);
  }

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
    /** 可选新描述：与内容 frontmatter 一并更新（name 是 Skill 身份，不允许改名）。 */
    description?: string;
    sourceEvidenceIds: string[];
  }): SkillDocument {
    const current = this.repository.getSkill(input.id);
    if (!current || !sameScope(current.scope, input.scope)) throw new NotFoundError(`skill not found: ${input.id}`);
    if (current.status === "archived" || current.status === "rejected") {
      throw new Error(`cannot update ${current.status} skill; create a new candidate instead`);
    }
    const description = input.description ?? current.description;
    validateSkillContent(current.name, description, input.content);
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
      description,
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

  // ---------------------------------------------------------------------
  // Task 13：质量校验、版本差异、回滚与使用记录
  // ---------------------------------------------------------------------

  /** 版本历史（新版本在前），供审核回看每个代次的内容与状态快照。 */
  listVersions(id: string, scope: Scope): SkillVersionRecord[] {
    const skill = this.get(id, scope);
    if (!skill) throw new NotFoundError(`skill not found: ${id}`);
    return this.repository.listSkillVersions(id);
  }

  /** 取单个历史版本。 */
  getVersion(id: string, scope: Scope, version: number): SkillVersionRecord {
    const skill = this.get(id, scope);
    if (!skill) throw new NotFoundError(`skill not found: ${id}`);
    const record = this.repository.getSkillVersion(id, version);
    if (!record) throw new NotFoundError(`skill version not found: ${id}@v${version}`);
    return record;
  }

  /**
   * 语义化版本差异。默认对照"最近一个已发布版本"（状态快照为
   * verified/deprecated 的最大历史版本）；没有已发布版本时回退到上一版本，
   * 首个版本则返回空差异。Verify 前调用，让审核者看清这版改了什么。
   */
  diff(id: string, scope: Scope, options: { fromVersion?: number; toVersion?: number } = {}): SkillDiffResult {
    const skill = this.get(id, scope);
    if (!skill) throw new NotFoundError(`skill not found: ${id}`);
    const versions = this.repository.listSkillVersions(id);
    const toVersion = options.toVersion ?? skill.version;
    const toRecord = versions.find((record) => record.version === toVersion);
    if (!toRecord) throw new NotFoundError(`skill version not found: ${id}@v${toVersion}`);

    let fromRecord: SkillVersionRecord | undefined;
    if (options.fromVersion !== undefined) {
      fromRecord = versions.find((record) => record.version === options.fromVersion);
      if (!fromRecord) throw new NotFoundError(`skill version not found: ${id}@v${options.fromVersion}`);
    } else {
      fromRecord = pickPublishedBaseline(versions, toVersion)
        ?? versions.find((record) => record.version < toVersion);
    }
    if (!fromRecord || fromRecord.version === toVersion) {
      return emptySkillDiff(fromRecord?.version ?? null, toVersion);
    }
    return diffSkillMarkdown(fromRecord.content, toRecord.content, fromRecord.version, toVersion);
  }

  /**
   * 回滚：把历史版本的内容追加为新的 Draft 版本。
   * 历史版本永不覆盖（skill_versions 主键约束），回滚本身也要再走一次
   * 人工 Verify；来源沿用当前仍存在的证据（证据已删的来源自动剔除）。
   */
  rollback(id: string, scope: Scope, targetVersion: number): SkillDocument {
    const skill = this.get(id, scope);
    if (!skill) throw new NotFoundError(`skill not found: ${id}`);
    if (skill.status === "archived" || skill.status === "rejected") {
      throw new Error(`cannot rollback ${skill.status} skill; create a new candidate instead`);
    }
    const target = this.repository.getSkillVersion(id, targetVersion);
    if (!target) throw new NotFoundError(`skill version not found: ${id}@v${targetVersion}`);
    if (target.version === skill.version) {
      throw new Error(`cannot rollback to current version ${skill.version}`);
    }
    const sources = skill.sources.filter((source) => this.repository.getEvidence(source.evidenceId));
    const rolledBack = this.repository.appendSkillVersion(
      id,
      skill.version,
      target.content,
      sources,
      this.now().toISOString(),
    );
    if (!rolledBack) throw new SkillVersionConflictError(id, skill.version);
    return rolledBack;
  }

  /** 当前版本的质量校验报告：错误级问题意味着不建议 Verify。 */
  validate(id: string, scope: Scope): SkillValidationReport {
    const skill = this.get(id, scope);
    if (!skill) throw new NotFoundError(`skill not found: ${id}`);
    return validateSkillDocument({
      name: skill.name,
      description: skill.description,
      content: skill.content,
      sources: skill.sources,
      sourceExists: (evidenceId) => this.repository.getEvidence(evidenceId) !== undefined,
    });
  }

  /** 记录一次使用事件（被召回/被采用/任务成功/任务失败）。 */
  recordRun(input: {
    skillId: string;
    scope: Scope;
    event: SkillRunRecord["event"];
    requestId?: string;
    note?: string;
  }): SkillRunRecord {
    return this.runs.record(input);
  }

  /** 使用效果汇总：只有落库的使用证据才能支撑"有效"的结论。 */
  runSummary(id: string, scope: Scope): SkillRunSummary {
    return this.runs.summary(id, scope);
  }
}

/** 最近已发布版本：状态快照为 verified/deprecated 且早于当前版本的最大版本号。 */
function pickPublishedBaseline(versions: readonly SkillVersionRecord[], currentVersion: number): SkillVersionRecord | undefined {
  return versions
    .filter((record) => record.version < currentVersion)
    .filter((record) => record.status === "verified" || record.status === "deprecated")
    .sort((a, b) => b.version - a.version)[0];
}

function validateSkillContent(name: string, description: string, content: string): void {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) throw new Error("invalid skill name");
  if (!description.trim()) throw new Error("skill description must not be empty");
  // 敏感信息是入库红线：与提案校验共用同一套规则，防止密钥进入长期资产
  if (containsSensitiveContent(`${name} ${description} ${content}`)) {
    throw new Error("skill content appears to contain sensitive values such as API keys");
  }
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
