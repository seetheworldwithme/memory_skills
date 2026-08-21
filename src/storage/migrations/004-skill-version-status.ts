import type { Migration } from "../migration-runner.js";

/**
 * 004 skill_versions 版本状态快照列（v0.6）：记录"该版本内容被替换时的治理状态"。
 * 新列允许为空——历史版本状态不可考，只有当前版本用 skills.status 回填；
 * 回填 UPDATE 天然幂等，列存在性检查用于兼容未走迁移链的旧库。
 */
export const migration004SkillVersionStatus: Migration = {
  id: 4,
  name: "skill-version-status",
  up(db) {
    const columns = db.prepare("PRAGMA table_info(skill_versions)").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "status")) {
      db.exec("ALTER TABLE skill_versions ADD COLUMN status TEXT");
    }
    db.exec(`
      UPDATE skill_versions
      SET status = (SELECT s.status FROM skills s WHERE s.id = skill_versions.skill_id)
      WHERE version = (SELECT s.current_version FROM skills s WHERE s.id = skill_versions.skill_id)
    `);
  },
};
