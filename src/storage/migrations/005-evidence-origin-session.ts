import type { Migration } from "../migration-runner.js";

/**
 * 005 evidence 来源会话列：记录证据产生的宿主会话 ID（如 Claude Code session_id）。
 * 该列与作用域过滤键 session_id 刻意解耦——scope.sessionId 把证据隔离进会话
 * 作用域（listEvidence/listMemory 都按它过滤），而 origin_session_id 只是溯源
 * 元数据，供"多独立会话佐证"等自动 Verify 规则使用，不影响可见性。
 * 可空列：历史证据来源不可考；列存在性检查兼容未走迁移链的旧库。
 */
export const migration005EvidenceOriginSession: Migration = {
  id: 5,
  name: "evidence-origin-session",
  up(db) {
    const columns = db.prepare("PRAGMA table_info(evidence)").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "origin_session_id")) {
      db.exec("ALTER TABLE evidence ADD COLUMN origin_session_id TEXT");
    }
  },
};
