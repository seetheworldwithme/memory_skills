import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { currentSchemaVersion, pendingMigrations, runMigrations } from "../src/storage/migration-runner.js";
import { MIGRATIONS } from "../src/storage/migrations/index.js";
import { migration001Core } from "../src/storage/migrations/001-core.js";
import { migration002Feedback } from "../src/storage/migrations/002-feedback.js";
import { SqliteRepository } from "../src/storage/sqlite-repository.js";

const readFileUtf8 = (path: string) => readFile(path, "utf8");

const scope = { userId: "alice", teamId: "team-a", agentId: "default" };

/**
 * 历史库 fixture 构造：用"当时的迁移子集"建库并塞入代表性数据，
 * 模拟从各历史版本升级到当前版本的真实路径。
 */
function buildLegacyDatabase(versions: number[], seed: (db: DatabaseSync) => void): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  for (const migration of MIGRATIONS.filter((item) => versions.includes(item.id))) {
    migration.up(db);
  }
  seed(db);
  return db;
}

/** 通用种子数据：一条证据、一条记忆、两个版本的 Skill（v2 为当前 draft）。 */
function seedCoreData(db: DatabaseSync): void {
  db.prepare(`
    INSERT INTO evidence (id,user_id,team_id,agent_id,session_id,role,content,captured_at)
    VALUES ('ev-1','alice','team-a','default',NULL,'user','原始证据','2026-08-01T00:00:00.000Z')
  `).run();
  db.prepare(`
    INSERT INTO memory_assets (id,layer,user_id,team_id,agent_id,session_id,content,governance_json,sources_json)
    VALUES ('mem-1','l1','alice','team-a','default',NULL,'历史记忆',
      '{"status":"verified","confidence":0.9,"createdReason":"seed","createdAt":"2026-08-01","updatedAt":"2026-08-01","sensitivity":"normal"}',
      '[{"evidenceId":"ev-1","capturedAt":"2026-08-01"}]')
  `).run();
  db.prepare("INSERT INTO memory_evidence VALUES ('mem-1','ev-1')").run();
  db.prepare(`
    INSERT INTO skills (id,user_id,team_id,agent_id,session_id,name,description,current_version,status,sources_json,created_at,updated_at)
    VALUES ('skill-1','alice','team-a','default',NULL,'deploy','部署','2','draft',
      '[{"evidenceId":"ev-1","capturedAt":"2026-08-01"}]','2026-08-01','2026-08-02')
  `).run();
  db.prepare(`
    INSERT INTO skill_versions (skill_id,version,content,created_at) VALUES
      ('skill-1',1,'v1 内容','2026-08-01'),
      ('skill-1',2,'v2 内容','2026-08-02')
  `).run();
}

test("全新库：从零应用全部迁移，结构与旧版内联建库一致", () => {
  const db = new DatabaseSync(":memory:");
  const report = runMigrations(db);
  assert.deepEqual(report.applied.map(({ id, name }) => [id, name]), [
    [1, "core-tables"], [2, "feedback"], [3, "skill-runs"], [4, "skill-version-status"],
  ]);
  assert.equal(report.baselineDetected, null);
  assert.equal(report.versionAfter, MIGRATIONS.length);

  // 关键表全部就位
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all().map((row) => row.name);
  for (const expected of ["evidence", "memory_assets", "memory_evidence", "skills", "skill_versions",
    "skill_evidence", "feedback", "skill_runs", "schema_migrations"]) {
    assert.ok(tables.includes(expected), `缺少表 ${expected}`);
  }
});

test("跨版本升级（历史 fixture 一：v0.2 核心库）：增量应用且旧数据完好", () => {
  // v0.2 库 = 只有 001 核心表
  const db = buildLegacyDatabase([1], seedCoreData);
  const report = runMigrations(db);
  assert.deepEqual(report.applied.map(({ id }) => id), [2, 3, 4]);
  assert.equal(currentSchemaVersion(db), MIGRATIONS.length);

  // 004 回填：当前版本（v2）拿到 skills.status，历史版本（v1）状态不可考为 NULL
  const statuses = db.prepare("SELECT version, status FROM skill_versions ORDER BY version").all();
  assert.deepEqual(
    statuses.map((row) => [Number(row.version), row.status === null || row.status === undefined ? null : row.status]),
    [[1, null], [2, "draft"]],
  );

  // 旧数据完好：证据、记忆、派生关系一条不少
  assert.equal(db.prepare("SELECT count(*) AS c FROM evidence").get()?.c, 1);
  assert.equal(db.prepare("SELECT count(*) AS c FROM memory_assets").get()?.c, 1);
  assert.equal(db.prepare("SELECT count(*) AS c FROM skill_versions").get()?.c, 2);
});

test("跨版本升级（历史 fixture 二：v0.5 反馈库）：只补 003/004", () => {
  // v0.5 库 = 001 + 002（有反馈表，无使用记录、无版本状态列）
  const db = buildLegacyDatabase([1, 2], (inner) => {
    seedCoreData(inner);
    inner.prepare(`
      INSERT INTO feedback (id,asset_kind,asset_id,asset_version,kind,user_id,team_id,agent_id,session_id,request_id,comment,created_at)
      VALUES ('fb-1','memory','mem-1','1','useful','alice','team-a','default',NULL,NULL,NULL,'2026-08-05')
    `).run();
  });
  const report = runMigrations(db);
  assert.deepEqual(report.applied.map(({ id }) => id), [3, 4]);

  // 反馈数据跨升级保留
  assert.equal(db.prepare("SELECT count(*) AS c FROM feedback").get()?.c, 1);
  assert.equal(db.prepare("SELECT status FROM skill_versions WHERE version = 2").get()?.status, "draft");
});

test("旧版内联建库（无 schema_migrations）：结构指纹识别基线，只登记不重放", () => {
  // 模拟现有 8421 生产库形态：全部表和 status 列都在，但从未登记迁移版本
  const db = buildLegacyDatabase([1, 2, 3, 4], seedCoreData);
  db.exec("DROP TABLE IF EXISTS schema_migrations");

  const report = runMigrations(db);
  assert.equal(report.baselineDetected, 4);
  assert.deepEqual(report.applied, []);
  assert.equal(currentSchemaVersion(db), MIGRATIONS.length);
  // 重复执行：稳定 no-op
  const again = runMigrations(db);
  assert.deepEqual(again.applied, []);
});

test("dryRun：只报告待应用迁移，不改动数据库", () => {
  const db = buildLegacyDatabase([1], seedCoreData);
  const report = runMigrations(db, { dryRun: true });
  assert.deepEqual(report.applied.map(({ id }) => id), [2, 3, 4]);
  // 库未被改动：feedback 表仍未创建
  const hasFeedback = db.prepare("SELECT name FROM sqlite_master WHERE name = 'feedback'").get();
  assert.equal(hasFeedback, undefined);
  // 真正执行后 pending 清零
  runMigrations(db);
  assert.equal(pendingMigrations(db).length, 0);
});

test("迁移应用前自动备份（backupDir）：产出 VACUUM 快照", async () => {
  const dir = await mkdtemp(join(tmpdir(), "memory-skills-migrate-"));
  try {
    // 文件库（:memory: 无法验证快照内容）：先建 v0.2 旧库
    const dbPath = join(dir, "legacy.db");
    const legacy = new DatabaseSync(dbPath);
    for (const migration of [migration001Core]) migration.up(legacy);
    seedCoreData(legacy);
    legacy.close();

    const db = new DatabaseSync(dbPath);
    const report = runMigrations(db, { backupDir: join(dir, "backups") });
    db.close();
    assert.ok(report.backupPath, "应产出备份路径");
    // 备份是升级前状态：无 feedback 表（v0.2 快照）
    const snapshot = new DatabaseSync(report.backupPath, { readOnly: true });
    assert.equal(snapshot.prepare("SELECT name FROM sqlite_master WHERE name='feedback'").get(), undefined);
    assert.equal(snapshot.prepare("SELECT count(*) AS c FROM evidence").get()?.c, 1);
    snapshot.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("迁移列表完整性：id 从 1 连续递增（注册表防拼错）", () => {
  assert.throws(
    () => runMigrations(new DatabaseSync(":memory:"), {
      migrations: [{ ...migration001Core }, { ...migration002Feedback, id: 5 }],
    }),
    /迁移列表不连续/,
  );
});

test("SqliteRepository 直接打开历史旧库：构造即升级，数据可正常读写", () => {
  const dbPath = join(tmpdir(), `memory-skills-repo-upgrade-${Date.now()}.db`);
  const legacy = new DatabaseSync(dbPath);
  migration001Core.up(legacy);
  seedCoreData(legacy);
  legacy.close();

  // 构造函数内跑迁移：旧库升级后立即可用
  const repository = new SqliteRepository(dbPath);
  try {
    const memory = repository.getMemoryScoped("mem-1", scope);
    assert.equal(memory?.content, "历史记忆");
    const skill = repository.listSkills(scope).find((item) => item.id === "skill-1");
    assert.equal(skill?.status, "draft");
    assert.equal(skill?.version, 2);
  } finally {
    repository.close();
  }
});

test("backup + restore 端到端：真实文件系统上的完整备份-恢复演练", async () => {
  const dir = await mkdtemp(join(tmpdir(), "memory-skills-restore-"));
  const root = resolve(process.cwd());
  try {
    // 1. 准备带数据的生产形态库
    const dbPath = join(dir, "prod.db");
    const repository = new SqliteRepository(dbPath);
    repository.captureEvidence({
      id: "prod-ev-1", scope, role: "user", content: "生产证据", capturedAt: "2026-08-20T00:00:00.000Z",
    });
    repository.close();

    // 2. 备份（子进程跑真实脚本）
    execFileSync("node", [
      join(root, "scripts/backup.mjs"), "--db", dbPath, "--out", join(dir, "backups"),
    ], { stdio: "pipe" });
    const manifestFile = readdirSync(join(dir, "backups")).find((name) => name.endsWith(".manifest.json"));
    assert.ok(manifestFile, "应产出 manifest");
    const manifest = JSON.parse(await readFileUtf8(join(dir, "backups", manifestFile)));

    // 3. 破坏生产库（模拟灾难）
    rmSync(dbPath);

    // 4. 恢复（tsimport 真实脚本）
    execFileSync("node", [
      "--import", "tsx", join(root, "scripts/restore.mjs"),
      join(dir, "backups", manifestFile), "--db", dbPath,
    ], { stdio: "pipe", cwd: root });

    // 5. 恢复后的库数据完好且可继续使用
    const restored = new SqliteRepository(dbPath);
    const evidence = restored.getEvidenceScoped("prod-ev-1", scope);
    assert.equal(evidence?.content, "生产证据");
    restored.close();
    assert.equal(manifest.databaseVersion, MIGRATIONS.length);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
