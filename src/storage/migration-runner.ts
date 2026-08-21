import { mkdirSync } from "node:fs";
import { join } from "node:path";

import type { DatabaseSync } from "node:sqlite";

import { MIGRATIONS } from "./migrations/index.js";

/**
 * 单向版本迁移执行器（Task 17）。
 * 原则：
 * - 迁移只在事务内前进，永不回滚；出错即整体中断，库停留在上一个完整版本；
 * - 对未登记版本的旧库（旧版内联 migrate() 建的）先做结构指纹基线识别再补登记，
 *   不会重复执行已生效的变更；
 * - dryRun 只报告待应用迁移，不写库；
 * - 提供备份目录时，应用任何迁移前先用 VACUUM INTO 留下自包含快照。
 */

export interface Migration {
  id: number;
  name: string;
  up(db: DatabaseSync): void;
}

export interface AppliedMigration {
  id: number;
  name: string;
  appliedAt: string;
}

export interface MigrationReport {
  /** 本次实际应用的迁移（dryRun 时为将应用的迁移）。 */
  applied: Array<{ id: number; name: string }>;
  /** 旧库结构指纹识别出的基线版本；全新库与已登记库为 null。 */
  baselineDetected: number | null;
  /** 应用前数据库版本（schema_migrations 最大 id，无记录为 0）。 */
  versionBefore: number;
  /** 应用后数据库版本；dryRun 时等于 versionBefore。 */
  versionAfter: number;
  /** 自动备份文件路径；未备份为 undefined。 */
  backupPath?: string;
  dryRun: boolean;
}

export function runMigrations(
  db: DatabaseSync,
  options: { dryRun?: boolean; backupDir?: string; migrations?: readonly Migration[] } = {},
): MigrationReport {
  const migrations = options.migrations ?? MIGRATIONS;
  assertContiguous(migrations);

  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )
  `);

  const recorded = new Set(listAppliedIds(db));
  let baselineDetected: number | null = null;

  // 旧库基线识别：schema_migrations 是空的，但业务表已存在（旧版内联 migrate() 建的）。
  // 按结构指纹推断已到达的版本并补登记，避免重复执行已生效的变更。
  if (recorded.size === 0) {
    const baseline = detectBaseline(db);
    if (baseline > 0) {
      baselineDetected = baseline;
      for (const migration of migrations) {
        if (migration.id > baseline) break;
        db.prepare("INSERT INTO schema_migrations (id, name, applied_at) VALUES (?,?,?)")
          .run(migration.id, migration.name, `${new Date().toISOString()} (legacy-baseline)`);
        recorded.add(migration.id);
      }
    }
  }

  const pending = migrations.filter((migration) => !recorded.has(migration.id));
  const versionBefore = Math.max(0, ...[...recorded]);
  if (options.dryRun) {
    return {
      applied: pending.map(({ id, name }) => ({ id, name })),
      baselineDetected,
      versionBefore,
      versionAfter: versionBefore,
      dryRun: true,
    };
  }

  let backupPath: string | undefined;
  // 备份的目的是"升级前保住已有数据"：全新库（无业务表）没有可丢数据，跳过
  const isFreshDatabase = versionBefore === 0 && baselineDetected === null && !hasTable(db, "evidence");
  if (pending.length > 0 && options.backupDir && !isFreshDatabase) {
    backupPath = backupBeforeMigrate(db, options.backupDir, versionBefore, pending[pending.length - 1]!.id);
  }

  for (const migration of pending) {
    // 每个迁移独立事务：up 与登记同生共死，绝不出现"执行了但没登记"
    db.exec("BEGIN");
    try {
      migration.up(db);
      db.prepare("INSERT INTO schema_migrations (id, name, applied_at) VALUES (?,?,?)")
        .run(migration.id, migration.name, new Date().toISOString());
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw new Error(`迁移 ${migration.id}-${migration.name} 失败（库停留在版本 ${versionBefore}）：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return {
    applied: pending.map(({ id, name }) => ({ id, name })),
    baselineDetected,
    versionBefore,
    versionAfter: Math.max(versionBefore, ...pending.map((migration) => migration.id)),
    ...(backupPath === undefined ? {} : { backupPath }),
    dryRun: false,
  };
}

/** 只读查询待应用迁移，不建表不写入；供启动预检与备份决策使用。 */
export function pendingMigrations(db: DatabaseSync, migrations: readonly Migration[] = MIGRATIONS): Migration[] {
  const recorded = new Set(listAppliedIds(db));
  const pending = migrations.filter((migration) => !recorded.has(migration.id));
  // 全新库（无任何业务表）从头应用是正常流程；旧库缺登记时按基线识别口径计算
  if (recorded.size === 0 && hasTable(db, "evidence")) {
    const baseline = detectBaseline(db);
    return pending.filter((migration) => migration.id > baseline);
  }
  return pending;
}

/** 当前数据库 Schema 版本：schema_migrations 最大 id；表不存在或为空返回 0。 */
export function currentSchemaVersion(db: DatabaseSync): number {
  if (!hasTable(db, "schema_migrations")) return 0;
  return Math.max(0, ...listAppliedIds(db));
}

function listAppliedIds(db: DatabaseSync): number[] {
  if (!hasTable(db, "schema_migrations")) return [];
  const rows = db.prepare("SELECT id FROM schema_migrations").all() as Array<{ id: number }>;
  return rows.map((row) => Number(row.id));
}

function hasTable(db: DatabaseSync, table: string): boolean {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
  return row !== undefined;
}

function columnExists(db: DatabaseSync, table: string, column: string): boolean {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return columns.some((row) => row.name === column);
}

/**
 * 旧库结构指纹：按"后出现的表/列"推断版本，返回已到达的迁移 id。
 * evidence 不存在视为全新库（0）；此后按 feedback → skill_runs → status 列逐级抬升。
 */
function detectBaseline(db: DatabaseSync): number {
  if (!hasTable(db, "evidence")) return 0;
  let baseline = 1;
  if (hasTable(db, "feedback")) baseline = 2;
  if (hasTable(db, "skill_runs")) baseline = 3;
  if (columnExists(db, "skill_versions", "status")) baseline = 4;
  return baseline;
}

/** 迁移必须从 1 开始连续递增：注册表拼错（跳号/重号）在启动时即失败。 */
function assertContiguous(migrations: readonly Migration[]): void {
  migrations.forEach((migration, index) => {
    if (migration.id !== index + 1) {
      throw new Error(`迁移列表不连续：第 ${index + 1} 项的 id 是 ${migration.id}，应为 ${index + 1}`);
    }
  });
}

/** 应用迁移前的自包含快照：VACUUM INTO 产出单文件副本，含 WAL 中未合并的数据。 */
function backupBeforeMigrate(db: DatabaseSync, backupDir: string, from: number, to: number): string {
  mkdirSync(backupDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const path = join(backupDir, `pre-migrate-v${from}-to-v${to}-${timestamp}.db`);
  db.prepare("VACUUM INTO ?").run(path);
  return path;
}
