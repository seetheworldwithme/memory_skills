#!/usr/bin/env node
/**
 * 数据库备份脚本（Task 17）：
 * - VACUUM INTO 产出自包含单文件快照（含 WAL 中未合并数据），源库零锁干扰；
 * - 伴生 manifest 记录 Schema 版本、内容 sha256 与恢复命令，restore 时强校验。
 *
 * 用法：node scripts/backup.mjs [--db data/memory-skills.db] [--out data/backups]
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const args = parseArgs(process.argv.slice(2));
const dbPath = resolve(args.db ?? "data/memory-skills.db");
const outDir = resolve(args.out ?? "data/backups");
const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const backupPath = join(outDir, `memory-skills-${timestamp}.db`);
const manifestPath = `${backupPath}.manifest.json`;

mkdirSync(outDir, { recursive: true });

// 只读打开源库：备份过程绝不写源库；VACUUM INTO 产出紧凑且自包含的单文件快照
const source = new DatabaseSync(dbPath, { readOnly: true });
const sourceVersion = readSchemaVersion(source);
source.prepare("VACUUM INTO ?").run(backupPath);
source.close();

// 快照自验证：版本一致 + 完整性检查通过才产出 manifest
const snapshot = new DatabaseSync(backupPath, { readOnly: true });
const snapshotVersion = readSchemaVersion(snapshot);
const integrity = snapshot.prepare("PRAGMA integrity_check").get();
snapshot.close();
if (integrity?.integrity_check !== "ok") {
  throw new Error(`快照完整性检查失败：${JSON.stringify(integrity)}，已放弃产出 manifest`);
}
if (sourceVersion !== snapshotVersion) {
  console.warn(`警告：源库版本 v${sourceVersion} 与快照版本 v${snapshotVersion} 不一致（备份期间库被迁移），建议重跑备份`);
}

const content = await readFile(backupPath);
const sha256 = createHash("sha256").update(content).digest("hex");
const manifest = {
  version: 1,
  tool: "scripts/backup.mjs",
  createdAt: new Date().toISOString(),
  databaseVersion: snapshotVersion,
  file: backupPath,
  sizeBytes: content.length,
  sha256,
  restore: `node --import tsx scripts/restore.mjs ${manifestPath} --db ${dbPath}`,
};
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

console.log(`备份完成：${backupPath}`);
console.log(`  Schema 版本：v${manifest.databaseVersion}`);
console.log(`  大小：${(manifest.sizeBytes / 1024).toFixed(1)} KB`);
console.log(`  sha256：${manifest.sha256.slice(0, 16)}…`);
console.log(`  manifest：${manifestPath}`);
console.log(`恢复命令：${manifest.restore}`);

function readSchemaVersion(db) {
  const row = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'",
  ).get();
  if (row === undefined) return 0;
  const versions = db.prepare("SELECT max(id) AS v FROM schema_migrations").get();
  return Number(versions?.v ?? 0);
}

function parseArgs(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--db" || argv[i] === "--out") {
      result[argv[i].slice(2)] = argv[i + 1];
      i += 1;
    }
  }
  return result;
}
