import type { Migration } from "../migration-runner.js";

/** 002 显式反馈表（v0.5）：刻意不加资产外键，资产删除后反馈仍保留作评测依据。 */
export const migration002Feedback: Migration = {
  id: 2,
  name: "feedback",
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS feedback (
        id TEXT PRIMARY KEY,
        asset_kind TEXT NOT NULL CHECK(asset_kind IN ('memory','skill')),
        asset_id TEXT NOT NULL,
        asset_version TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('useful','irrelevant','incorrect','outdated')),
        user_id TEXT NOT NULL,
        team_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        session_id TEXT,
        request_id TEXT,
        comment TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS feedback_scope_time
      ON feedback(user_id, team_id, agent_id, IFNULL(session_id, ''), created_at DESC);
    `);
  },
};
