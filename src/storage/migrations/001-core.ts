import type { Migration } from "../migration-runner.js";

/**
 * 001 核心表（v0.2 基线）：Evidence、Memory、Skill 及派生关系。
 * 内容与旧版 SqliteRepository.migrate() 的建表语句逐字一致——
 * 从零建库与旧库升级必须得到相同结构。
 */
export const migration001Core: Migration = {
  id: 1,
  name: "core-tables",
  up(db) {
    db.exec(`
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
  },
};
