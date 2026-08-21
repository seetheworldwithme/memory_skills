import type { Migration } from "../migration-runner.js";

/** 003 Skill 使用记录表（v0.6）：与反馈同理不加资产外键，资产归档后使用证据仍保留。 */
export const migration003SkillRuns: Migration = {
  id: 3,
  name: "skill-runs",
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS skill_runs (
        id TEXT PRIMARY KEY,
        skill_id TEXT NOT NULL,
        skill_version INTEGER NOT NULL,
        user_id TEXT NOT NULL,
        team_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        session_id TEXT,
        event TEXT NOT NULL CHECK(event IN ('recalled','adopted','succeeded','failed')),
        request_id TEXT,
        note TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS skill_runs_scope_time
      ON skill_runs(user_id, team_id, agent_id, IFNULL(session_id, ''), created_at DESC);

      CREATE INDEX IF NOT EXISTS skill_runs_skill_time
      ON skill_runs(skill_id, created_at DESC);
    `);
  },
};
