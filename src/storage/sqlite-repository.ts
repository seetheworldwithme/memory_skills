import { DatabaseSync } from "node:sqlite";

import type { GovernedStatus } from "../governance/lifecycle.js";
import type { GovernanceMetadata, Scope, SourceReference } from "../governance/types.js";
import type { FeedbackRecord } from "../feedback/types.js";
import type { Evidence, MemoryAsset, MemoryLayer } from "../memory/types.js";
import type { SkillDocument, SkillVersionRecord } from "../skills/types.js";
import type { SkillRunRecord } from "../skills/skill-run-record.js";
import { runMigrations } from "./migration-runner.js";

type DbRow = Record<string, unknown>;

export class SqliteRepository {
  private readonly db: DatabaseSync;

  constructor(path: string, options: { migrationBackupDir?: string } = {}) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
    // Schema 由版本化迁移统一管理（Task 17）：旧库自动基线识别后补增量，全新库从 001 建起；
    // 给出备份目录时，应用迁移前先留 VACUUM 快照（全新库无数据可丢，自动跳过）
    runMigrations(this.db, options.migrationBackupDir === undefined
      ? {}
      : { backupDir: options.migrationBackupDir });
  }

  close(): void {
    this.db.close();
  }

  captureEvidence(evidence: Evidence): Evidence {
    const existing = this.getEvidence(evidence.id);
    if (existing) {
      if (!sameScope(existing.scope, evidence.scope)
        || existing.role !== evidence.role
        || existing.content !== evidence.content) {
        throw new Error(`evidence id conflict: ${evidence.id}`);
      }
      return existing;
    }
    this.db.prepare(`
      INSERT OR IGNORE INTO evidence
      (id,user_id,team_id,agent_id,session_id,role,content,captured_at)
      VALUES (?,?,?,?,?,?,?,?)
    `).run(
      evidence.id,
      evidence.scope.userId,
      evidence.scope.teamId,
      evidence.scope.agentId,
      evidence.scope.sessionId ?? null,
      evidence.role,
      evidence.content,
      evidence.capturedAt,
    );
    return this.getEvidence(evidence.id)!;
  }

  getEvidence(id: string): Evidence | undefined {
    const row = this.db.prepare("SELECT * FROM evidence WHERE id = ?").get(id) as DbRow | undefined;
    return row ? rowToEvidence(row) : undefined;
  }

  getEvidenceScoped(id: string, scope: Scope): Evidence | undefined {
    const evidence = this.getEvidence(id);
    return evidence && sameScope(evidence.scope, scope) ? evidence : undefined;
  }

  /** 按作用域列出证据，时间倒序（最新在前）；提案流水线默认取最近一批。 */
  listEvidence(scope: Scope, limit = 50): Evidence[] {
    if (!Number.isInteger(limit) || limit <= 0) throw new Error("limit must be a positive integer");
    const rows = this.db.prepare(`
      SELECT * FROM evidence
      WHERE user_id = ? AND team_id = ? AND agent_id = ? AND IFNULL(session_id, '') = IFNULL(?, '')
      ORDER BY captured_at DESC, id DESC
      LIMIT ?
    `).all(scope.userId, scope.teamId, scope.agentId, scope.sessionId ?? null, limit) as DbRow[];
    return rows.map(rowToEvidence);
  }

  countEvidence(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS count FROM evidence").get() as DbRow;
    return Number(row.count);
  }

  insertMemory(asset: MemoryAsset): MemoryAsset {
    for (const source of asset.sources) {
      if (!this.getEvidence(source.evidenceId)) {
        throw new Error(`source evidence not found: ${source.evidenceId}`);
      }
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(`
        INSERT INTO memory_assets
        (id,layer,user_id,team_id,agent_id,session_id,content,governance_json,sources_json)
        VALUES (?,?,?,?,?,?,?,?,?)
      `).run(
        asset.id,
        asset.layer,
        asset.scope.userId,
        asset.scope.teamId,
        asset.scope.agentId,
        asset.scope.sessionId ?? null,
        asset.content,
        JSON.stringify(asset.governance),
        JSON.stringify(asset.sources),
      );
      const link = this.db.prepare("INSERT INTO memory_evidence(memory_id,evidence_id) VALUES (?,?)");
      for (const source of asset.sources) link.run(asset.id, source.evidenceId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return asset;
  }

  getMemory(id: string): MemoryAsset | undefined {
    const row = this.db.prepare("SELECT * FROM memory_assets WHERE id = ?").get(id) as DbRow | undefined;
    return row ? rowToMemory(row) : undefined;
  }

  getMemoryScoped(id: string, scope: Scope): MemoryAsset | undefined {
    const asset = this.getMemory(id);
    return asset && sameScope(asset.scope, scope) ? asset : undefined;
  }

  updateMemoryStatus(id: string, status: GovernedStatus, updatedAt: string): MemoryAsset {
    const asset = this.getMemory(id);
    if (!asset) throw new Error(`memory not found: ${id}`);
    asset.governance.status = status;
    asset.governance.updatedAt = updatedAt;
    if (status === "verified") asset.governance.lastVerifiedAt = updatedAt;
    this.db.prepare("UPDATE memory_assets SET governance_json = ? WHERE id = ?")
      .run(JSON.stringify(asset.governance), id);
    return asset;
  }

  listMemory(scope: Scope): MemoryAsset[] {
    const rows = this.db.prepare(`
      SELECT * FROM memory_assets
      WHERE user_id = ? AND team_id = ? AND agent_id = ?
      AND session_id IS ?
    `).all(
      scope.userId,
      scope.teamId,
      scope.agentId,
      scope.sessionId ?? null,
    ) as DbRow[];
    return rows.map(rowToMemory);
  }

  /**
   * 删除证据并传播到派生资产（Task 14 语义调整）：
   * 来源已消失的 Verified 资产默认标记为待复核（deprecated，可恢复），
   * 不再直接打入终态 archived，也不静默保持 Verified；
   * Draft 等其余状态保持不变，由质量校验器在 Verify 前暴露"来源悬空"。
   */
  deleteEvidenceAndPropagate(
    id: string,
    scope: Scope,
    now: string,
  ): {
    memories: Array<{ id: string; from: GovernedStatus; to: GovernedStatus }>;
    skills: Array<{ id: string; from: GovernedStatus; to: GovernedStatus }>;
  } {
    if (!this.getEvidenceScoped(id, scope)) throw new Error(`evidence not found: ${id}`);
    const memoryRows = this.db.prepare("SELECT memory_id FROM memory_evidence WHERE evidence_id = ? ORDER BY memory_id")
      .all(id) as DbRow[];
    const skillRows = this.db.prepare("SELECT skill_id FROM skill_evidence WHERE evidence_id = ? ORDER BY skill_id")
      .all(id) as DbRow[];

    this.db.exec("BEGIN IMMEDIATE");
    try {
      const memoryTransitions: Array<{ id: string; from: GovernedStatus; to: GovernedStatus }> = [];
      for (const row of memoryRows) {
        const memoryId = String(row.memory_id);
        const asset = this.getMemory(memoryId);
        if (!asset) continue;
        const from = asset.governance.status;
        const to: GovernedStatus = from === "verified" ? "deprecated" : from;
        if (to !== from) {
          asset.governance.status = to;
          asset.governance.updatedAt = now;
          this.db.prepare("UPDATE memory_assets SET governance_json = ? WHERE id = ?")
            .run(JSON.stringify(asset.governance), memoryId);
        }
        memoryTransitions.push({ id: memoryId, from, to });
      }
      const skillTransitions: Array<{ id: string; from: GovernedStatus; to: GovernedStatus }> = [];
      for (const row of skillRows) {
        const skillId = String(row.skill_id);
        const skill = this.getSkill(skillId);
        if (!skill) continue;
        const from = skill.status;
        const to: GovernedStatus = from === "verified" ? "deprecated" : from;
        if (to !== from) {
          this.db.prepare("UPDATE skills SET status = ?, updated_at = ? WHERE id = ?").run(to, now, skillId);
          this.db.prepare(`
            UPDATE skill_versions SET status = ?
            WHERE skill_id = ? AND version = (SELECT current_version FROM skills WHERE id = ?)
          `).run(to, skillId, skillId);
        }
        skillTransitions.push({ id: skillId, from, to });
      }
      this.db.prepare("DELETE FROM evidence WHERE id = ?").run(id);
      this.db.exec("COMMIT");
      return { memories: memoryTransitions, skills: skillTransitions };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  insertSkill(skill: SkillDocument): SkillDocument {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(`
        INSERT INTO skills
        (id,user_id,team_id,agent_id,session_id,name,description,current_version,status,sources_json,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        skill.id,
        skill.scope.userId,
        skill.scope.teamId,
        skill.scope.agentId,
        skill.scope.sessionId ?? null,
        skill.name,
        skill.description,
        skill.version,
        skill.status,
        JSON.stringify(skill.sources),
        skill.createdAt,
        skill.updatedAt,
      );
      this.db.prepare("INSERT INTO skill_versions(skill_id,version,content,created_at,status) VALUES (?,?,?,?,?)")
        .run(skill.id, skill.version, skill.content, skill.createdAt, skill.status);
      const link = this.db.prepare("INSERT INTO skill_evidence(skill_id,evidence_id) VALUES (?,?)");
      for (const source of skill.sources) link.run(skill.id, source.evidenceId);
      this.db.exec("COMMIT");
      return skill;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  getSkill(id: string): SkillDocument | undefined {
    const row = this.db.prepare(`
      SELECT s.*, v.content FROM skills s
      JOIN skill_versions v ON v.skill_id = s.id AND v.version = s.current_version
      WHERE s.id = ?
    `).get(id) as DbRow | undefined;
    return row ? rowToSkill(row) : undefined;
  }

  appendSkillVersion(
    id: string,
    expectedVersion: number,
    content: string,
    sources: SourceReference[],
    now: string,
    description?: string,
  ): SkillDocument | undefined {
    const skill = this.getSkill(id);
    if (!skill || skill.version !== expectedVersion) return undefined;
    const next = expectedVersion + 1;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = this.db.prepare(`
        UPDATE skills
        SET current_version = ?, status = 'draft', sources_json = ?, updated_at = ?${description === undefined ? "" : ", description = ?"}
        WHERE id = ? AND current_version = ?
      `).run(...([
        next, JSON.stringify(sources), now,
        ...(description === undefined ? [] : [description]),
        id, expectedVersion,
      ]));
      if (result.changes !== 1) {
        this.db.exec("ROLLBACK");
        return undefined;
      }
      this.db.prepare("INSERT INTO skill_versions(skill_id,version,content,created_at,status) VALUES (?,?,?,?,?)")
        .run(id, next, content, now, "draft");
      this.db.prepare("DELETE FROM skill_evidence WHERE skill_id = ?").run(id);
      const link = this.db.prepare("INSERT INTO skill_evidence(skill_id,evidence_id) VALUES (?,?)");
      for (const source of sources) link.run(id, source.evidenceId);
      this.db.exec("COMMIT");
      return this.getSkill(id);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  updateSkillStatus(id: string, status: GovernedStatus, now: string): SkillDocument {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = this.db.prepare("UPDATE skills SET status = ?, updated_at = ? WHERE id = ?")
        .run(status, now, id);
      if (result.changes !== 1) {
        this.db.exec("ROLLBACK");
        throw new Error(`skill not found: ${id}`);
      }
      // 版本状态快照与主表保持同步：当前版本行的 status 就是它此刻的治理状态
      this.db.prepare(`
        UPDATE skill_versions SET status = ?
        WHERE skill_id = ? AND version = (SELECT current_version FROM skills WHERE id = ?)
      `).run(status, id, id);
      this.db.exec("COMMIT");
      return this.getSkill(id)!;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /** 取指定历史版本（含内容与状态快照）；不存在返回 undefined。 */
  getSkillVersion(id: string, version: number): SkillVersionRecord | undefined {
    const row = this.db.prepare(
      "SELECT * FROM skill_versions WHERE skill_id = ? AND version = ?",
    ).get(id, version) as DbRow | undefined;
    return row ? rowToSkillVersion(row) : undefined;
  }

  /** 版本历史，新版本在前。 */
  listSkillVersions(id: string): SkillVersionRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM skill_versions WHERE skill_id = ? ORDER BY version DESC
    `).all(id) as DbRow[];
    return rows.map(rowToSkillVersion);
  }

  listSkills(scope: Scope): SkillDocument[] {
    const rows = this.db.prepare(`
      SELECT s.*, v.content FROM skills s
      JOIN skill_versions v ON v.skill_id = s.id AND v.version = s.current_version
      WHERE s.user_id = ? AND s.team_id = ? AND s.agent_id = ?
      AND s.session_id IS ?
      ORDER BY s.updated_at DESC
    `).all(scope.userId, scope.teamId, scope.agentId, scope.sessionId ?? null) as DbRow[];
    return rows.map(rowToSkill);
  }

  /** 落库一条显式反馈：ID 冲突时由主键约束抛错，由调用方映射为 409。 */
  insertFeedback(record: FeedbackRecord): FeedbackRecord {
    this.db.prepare(`
      INSERT INTO feedback
      (id,asset_kind,asset_id,asset_version,kind,user_id,team_id,agent_id,session_id,request_id,comment,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      record.id,
      record.assetKind,
      record.assetId,
      record.assetVersion,
      record.kind,
      record.scope.userId,
      record.scope.teamId,
      record.scope.agentId,
      record.scope.sessionId ?? null,
      record.requestId ?? null,
      record.comment ?? null,
      record.createdAt,
    );
    return record;
  }

  /** 按作用域列出反馈，时间倒序（最新在前）。 */
  listFeedback(scope: Scope): FeedbackRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM feedback
      WHERE user_id = ? AND team_id = ? AND agent_id = ?
      AND session_id IS ?
      ORDER BY created_at DESC, id DESC
    `).all(scope.userId, scope.teamId, scope.agentId, scope.sessionId ?? null) as DbRow[];
    return rows.map(rowToFeedback);
  }

  /** 统计某资产在某作用域的四类反馈计数（治理建议与使用效果汇总用）。 */
  countFeedbackByKind(
    assetKind: "memory" | "skill",
    assetId: string,
    scope: Scope,
  ): { useful: number; irrelevant: number; incorrect: number; outdated: number } {
    const rows = this.db.prepare(`
      SELECT kind, COUNT(*) AS count FROM feedback
      WHERE asset_kind = ? AND asset_id = ?
      AND user_id = ? AND team_id = ? AND agent_id = ? AND session_id IS ?
      GROUP BY kind
    `).all(assetKind, assetId, scope.userId, scope.teamId, scope.agentId, scope.sessionId ?? null) as DbRow[];
    const counts = { useful: 0, irrelevant: 0, incorrect: 0, outdated: 0 };
    for (const row of rows) counts[String(row.kind) as keyof typeof counts] = Number(row.count);
    return counts;
  }

  /** 落库一条 Skill 使用记录。 */
  insertSkillRun(record: SkillRunRecord): SkillRunRecord {
    this.db.prepare(`
      INSERT INTO skill_runs
      (id,skill_id,skill_version,user_id,team_id,agent_id,session_id,event,request_id,note,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      record.id,
      record.skillId,
      record.skillVersion,
      record.scope.userId,
      record.scope.teamId,
      record.scope.agentId,
      record.scope.sessionId ?? null,
      record.event,
      record.requestId ?? null,
      record.note ?? null,
      record.createdAt,
    );
    return record;
  }

  /** 按事件类型统计某 Skill 的使用记录数。 */
  countSkillRuns(skillId: string): Partial<Record<SkillRunRecord["event"], number>> {
    const rows = this.db.prepare(
      "SELECT event, COUNT(*) AS count FROM skill_runs WHERE skill_id = ? GROUP BY event",
    ).all(skillId) as DbRow[];
    const counts: Partial<Record<SkillRunRecord["event"], number>> = {};
    for (const row of rows) counts[String(row.event) as SkillRunRecord["event"]] = Number(row.count);
    return counts;
  }

  /** 更新记忆有效期（续期/清除期限）：只改 governance 元数据，不动状态与内容。 */
  updateMemoryValidity(
    id: string,
    patch: { validFrom?: string | null; validUntil?: string | null },
    now: string,
  ): MemoryAsset {
    const asset = this.getMemory(id);
    if (!asset) throw new Error(`memory not found: ${id}`);
    if (patch.validFrom !== undefined) {
      if (patch.validFrom === null) delete asset.governance.validFrom;
      else asset.governance.validFrom = patch.validFrom;
    }
    if (patch.validUntil !== undefined) {
      if (patch.validUntil === null) delete asset.governance.validUntil;
      else asset.governance.validUntil = patch.validUntil;
    }
    asset.governance.updatedAt = now;
    this.db.prepare("UPDATE memory_assets SET governance_json = ? WHERE id = ?")
      .run(JSON.stringify(asset.governance), id);
    return asset;
  }
}

function rowToEvidence(row: DbRow): Evidence {
  return {
    id: String(row.id),
    scope: rowToScope(row),
    role: String(row.role) as Evidence["role"],
    content: String(row.content),
    capturedAt: String(row.captured_at),
  };
}

function rowToMemory(row: DbRow): MemoryAsset {
  return {
    id: String(row.id),
    layer: String(row.layer) as MemoryLayer,
    scope: rowToScope(row),
    content: String(row.content),
    governance: JSON.parse(String(row.governance_json)) as GovernanceMetadata,
    sources: JSON.parse(String(row.sources_json)) as SourceReference[],
  };
}

function rowToSkill(row: DbRow): SkillDocument {
  return {
    id: String(row.id),
    scope: rowToScope(row),
    name: String(row.name),
    description: String(row.description),
    content: String(row.content),
    version: Number(row.current_version),
    status: String(row.status) as GovernedStatus,
    sources: JSON.parse(String(row.sources_json)) as SourceReference[],
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function rowToSkillVersion(row: DbRow): SkillVersionRecord {
  return {
    skillId: String(row.skill_id),
    version: Number(row.version),
    content: String(row.content),
    status: row.status == null ? null : String(row.status) as SkillVersionRecord["status"],
    createdAt: String(row.created_at),
  };
}

function rowToFeedback(row: DbRow): FeedbackRecord {
  return {
    id: String(row.id),
    assetKind: String(row.asset_kind) as FeedbackRecord["assetKind"],
    assetId: String(row.asset_id),
    assetVersion: String(row.asset_version),
    kind: String(row.kind) as FeedbackRecord["kind"],
    scope: rowToScope(row),
    ...(row.request_id == null ? {} : { requestId: String(row.request_id) }),
    ...(row.comment == null ? {} : { comment: String(row.comment) }),
    createdAt: String(row.created_at),
  };
}

function rowToScope(row: DbRow): Scope {
  const scope: Scope = {
    userId: String(row.user_id),
    teamId: String(row.team_id),
    agentId: String(row.agent_id),
  };
  if (row.session_id != null) scope.sessionId = String(row.session_id);
  return scope;
}

function sameScope(a: Scope, b: Scope): boolean {
  return a.userId === b.userId
    && a.teamId === b.teamId
    && a.agentId === b.agentId
    && (a.sessionId ?? null) === (b.sessionId ?? null);
}
