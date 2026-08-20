import { DatabaseSync } from "node:sqlite";

import type { GovernedStatus } from "../governance/lifecycle.js";
import type { GovernanceMetadata, Scope, SourceReference } from "../governance/types.js";
import type { Evidence, MemoryAsset, MemoryLayer } from "../memory/types.js";
import type { SkillDocument } from "../skills/types.js";

type DbRow = Record<string, unknown>;

export class SqliteRepository {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS evidence (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        team_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        session_id TEXT,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        captured_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS memory_assets (
        id TEXT PRIMARY KEY,
        layer TEXT NOT NULL CHECK(layer IN ('l1','l2','l3')),
        user_id TEXT NOT NULL,
        team_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        session_id TEXT,
        content TEXT NOT NULL,
        governance_json TEXT NOT NULL,
        sources_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS memory_evidence (
        memory_id TEXT NOT NULL REFERENCES memory_assets(id) ON DELETE CASCADE,
        evidence_id TEXT NOT NULL REFERENCES evidence(id) ON DELETE CASCADE,
        PRIMARY KEY(memory_id, evidence_id)
      );

      CREATE TABLE IF NOT EXISTS skills (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        team_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        session_id TEXT,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        current_version INTEGER NOT NULL,
        status TEXT NOT NULL,
        sources_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS skill_versions (
        skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
        version INTEGER NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(skill_id, version)
      );

      CREATE UNIQUE INDEX IF NOT EXISTS skills_scope_name
      ON skills(user_id, team_id, agent_id, IFNULL(session_id, ''), name);

      CREATE TABLE IF NOT EXISTS skill_evidence (
        skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
        evidence_id TEXT NOT NULL REFERENCES evidence(id) ON DELETE CASCADE,
        PRIMARY KEY(skill_id, evidence_id)
      );
    `);
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

  deleteEvidenceAndArchiveDerived(id: string, scope: Scope, now: string): { memoryIds: string[]; skillIds: string[] } {
    if (!this.getEvidenceScoped(id, scope)) throw new Error(`evidence not found: ${id}`);
    const rows = this.db.prepare("SELECT memory_id FROM memory_evidence WHERE evidence_id = ? ORDER BY memory_id")
      .all(id) as DbRow[];
    const ids = rows.map((row) => String(row.memory_id));
    const skillRows = this.db.prepare("SELECT skill_id FROM skill_evidence WHERE evidence_id = ? ORDER BY skill_id")
      .all(id) as DbRow[];
    const skillIds = skillRows.map((row) => String(row.skill_id));
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const memoryId of ids) {
        const asset = this.getMemory(memoryId);
        if (!asset) continue;
        asset.governance.status = "archived";
        asset.governance.updatedAt = now;
        this.db.prepare("UPDATE memory_assets SET governance_json = ? WHERE id = ?")
          .run(JSON.stringify(asset.governance), memoryId);
      }
      for (const skillId of skillIds) {
        this.db.prepare("UPDATE skills SET status = 'archived', updated_at = ? WHERE id = ?")
          .run(now, skillId);
      }
      this.db.prepare("DELETE FROM evidence WHERE id = ?").run(id);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return { memoryIds: ids, skillIds };
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
      this.db.prepare("INSERT INTO skill_versions(skill_id,version,content,created_at) VALUES (?,?,?,?)")
        .run(skill.id, skill.version, skill.content, skill.createdAt);
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
  ): SkillDocument | undefined {
    const skill = this.getSkill(id);
    if (!skill || skill.version !== expectedVersion) return undefined;
    const next = expectedVersion + 1;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = this.db.prepare(`
        UPDATE skills SET current_version = ?, status = 'draft', sources_json = ?, updated_at = ?
        WHERE id = ? AND current_version = ?
      `).run(next, JSON.stringify(sources), now, id, expectedVersion);
      if (result.changes !== 1) {
        this.db.exec("ROLLBACK");
        return undefined;
      }
      this.db.prepare("INSERT INTO skill_versions(skill_id,version,content,created_at) VALUES (?,?,?,?)")
        .run(id, next, content, now);
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
    const result = this.db.prepare("UPDATE skills SET status = ?, updated_at = ? WHERE id = ?")
      .run(status, now, id);
    if (result.changes !== 1) throw new Error(`skill not found: ${id}`);
    return this.getSkill(id)!;
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
