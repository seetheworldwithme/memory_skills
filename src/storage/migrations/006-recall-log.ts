import type { Migration } from "../migration-runner.js";

/**
 * 006 召回日志表：持久化 requestId → 查询/命中资产/分数的关联，
 * 用于反馈回流评测集与采用率统计（北极星指标的近似口径）。
 * 刻意不加资产外键（同 feedback）：资产删除后日志仍保留作评测依据。
 * 隐私边界：query 只进本地 SQLite（与 evidence 同级），
 * 不进观测 JSONL 事件、不进任何 API 响应。
 */
export const migration006RecallLog: Migration = {
  id: 6,
  name: "recall-log",
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS recall_log (
        request_id TEXT PRIMARY KEY,
        query TEXT NOT NULL,
        user_id TEXT NOT NULL,
        team_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        session_id TEXT,
        retrieval_strategy TEXT,
        memory_hits TEXT NOT NULL,
        skill_hits TEXT NOT NULL,
        duration_ms INTEGER,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS recall_log_scope_time
      ON recall_log(user_id, team_id, agent_id, created_at DESC);
    `);
  },
};
