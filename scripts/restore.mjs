#!/usr/bin/env node
/**
 * 数据库恢复脚本（Task 17）：
 * - 强校验 manifest（sha256、来源工具）后才允许恢复，防止误用不明文件；
 * - 恢复先落到临时库：跑迁移升到当前代码 Schema + integrity/外键检查，
 *   全部通过才替换目标库（目标原文件自动保底备份，绝不直接覆盖丢失）；
 * - 替换时清理目标的 -wal/-shm 附属文件，避免新旧混搭。
 *
 * 用法：node --import tsx scripts/restore.mjs <backup.db|.manifest.json> [--db data/memory-skills.db]
 * 注意：恢复前先停止 memory-skills 服务（运行中的连接持有 WAL，替换会失效甚至损坏）。
 */
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

// 迁移执行器是 TS 模块：本脚本必须以 node --import tsx 运行（见 package.json restore 脚本）
const { runMigrations, currentSchemaVersion } = await import("../src/storage/migration-runner.js");

const positional = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
const flagValue = (name) => {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
};

const inputPath = resolve(positional[0] ?? "");
const dbPath = resolve(flagValue("--db") ?? "data/memory-skills.db");
if (!inputPath || !existsSync(inputPath)) {
  console.error("用法：node --import tsx scripts/restore.mjs <backup.db|.manifest.json> [--db <目标库路径>]");
  process.exit(1);
}

// 1. 解析 manifest：输入是 manifest 就直接用；是备份文件就找同目录伴生 manifest
let manifestPath = inputPath.endsWith(".manifest.json") ? inputPath : `${inputPath}.manifest.json`;
let backupPath = inputPath.endsWith(".manifest.json") ? undefined : inputPath;
if (!existsSync(manifestPath)) {
  console.error(`找不到伴生 manifest：${manifestPath}\n没有 manifest 的备份无法校验来源与完整性；确信无误请先用 backup.mjs 重新备份。`);
  process.exit(1);
}
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
if (manifest.tool !== "scripts/backup.mjs" || typeof manifest.sha256 !== "string") {
  console.error(`manifest 不是 backup.mjs 产出的有效格式：${manifestPath}`);
  process.exit(1);
}
if (backupPath === undefined) backupPath = resolve(manifest.file);

// 2. 内容哈希强校验：比特级一致才继续
const actual = createHash("sha256").update(await readFile(backupPath)).digest("hex");
if (actual !== manifest.sha256) {
  console.error(`备份文件哈希不匹配：\n  期望 ${manifest.sha256}\n  实际 ${actual}\n文件可能已损坏或被篡改，拒绝恢复。`);
  process.exit(1);
}
console.log(`哈希校验通过（sha256 ${actual.slice(0, 16)}…，备份时 Schema v${manifest.databaseVersion}）`);

// 3. 临时库验证：迁移到当前代码 Schema + 完整性 + 外键检查
mkdirSync(dirname(dbPath), { recursive: true });
const stagingPath = `${dbPath}.restore-staging-${Date.now()}`;
copyFileSync(backupPath, stagingPath);
try {
  const staging = new DatabaseSync(stagingPath);
  try {
    staging.exec("PRAGMA foreign_keys = ON;");
    const report = runMigrations(staging);
    for (const applied of report.applied) {
      console.log(`  临时库迁移应用：${applied.id}-${applied.name}`);
    }
    const integrity = staging.prepare("PRAGMA integrity_check").get();
    if (integrity?.integrity_check !== "ok") {
      throw new Error(`integrity_check 失败：${JSON.stringify(integrity)}`);
    }
    const fkViolations = staging.prepare("PRAGMA foreign_key_check").all();
    if (fkViolations.length > 0) {
      throw new Error(`foreign_key_check 发现 ${fkViolations.length} 处违例`);
    }
    console.log(`临时库验证通过：integrity ok、外键无违例、Schema v${currentSchemaVersion(staging)}`);
  } finally {
    staging.close();
  }

  // 4. 替换目标：原库先保底备份，再原子换入临时库；清掉旧 WAL 附属文件防混搭
  if (existsSync(dbPath)) {
    const safetyPath = `${dbPath}.pre-restore-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    copyFileSync(dbPath, `${safetyPath}`);
    console.log(`原库已保底备份：${safetyPath}`);
  }
  for (const suffix of ["-wal", "-shm"]) {
    if (existsSync(`${dbPath}${suffix}`)) rmSync(`${dbPath}${suffix}`);
  }
  renameSync(stagingPath, dbPath);
  console.log(`恢复完成：${dbPath}（${(statSync(dbPath).size / 1024).toFixed(1)} KB）`);
  console.log("现在可以重新启动服务。");
} catch (error) {
  if (existsSync(stagingPath)) rmSync(stagingPath);
  console.error(`恢复中止（目标库未受影响）：${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
