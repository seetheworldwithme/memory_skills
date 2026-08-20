import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import type { Scope } from "../governance/types.js";
import type { AssetKind, VectorIndex, VectorIndexEntry, VectorMatch, VectorQuery } from "./types.js";

type DbRow = Record<string, unknown>;

/**
 * 第一版向量索引：SQLite 表保存 embedding 元数据与版本，向量本体以 JSON 存储，
 * 余弦相似度在 JS 中计算。以最小可替换为目标：接口不泄漏任何 SQLite 细节，
 * 后续换专门向量库只需替换本实现。
 *
 * 版本策略：行携带模型名，构造时绑定当前模型，读写都按模型过滤——
 * 更换 Embedding 模型后旧向量自动失效（不被检索），需要重跑同步。
 * 作用域以 scope_key（userId|teamId|agentId|sessionId）做行级隔离，
 * 与主库的作用域过滤语义一致：跨作用域向量永不进入检索结果。
 */
export class SqliteVectorIndex implements VectorIndex {
  readonly model: string;
  private readonly db: DatabaseSync;
  private readonly closedByOwner: boolean;

  /**
   * @param databasePath SQLite 文件路径；与主库同文件时依赖 WAL 支持多连接并发读写
   * @param existingDb 已打开的连接（测试内存库复用）；传入后本类不负责关闭
   */
  constructor(model: string, databasePath: string, existingDb?: DatabaseSync) {
    this.model = model;
    if (existingDb) {
      this.db = existingDb;
      this.closedByOwner = false;
    } else {
      this.db = new DatabaseSync(databasePath);
      this.closedByOwner = true;
    }
    this.migrate();
  }

  close(): void {
    if (this.closedByOwner) this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS asset_embeddings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        scope_key TEXT NOT NULL,
        asset_kind TEXT NOT NULL CHECK(asset_kind IN ('memory','skill')),
        asset_id TEXT NOT NULL,
        model TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        dim INTEGER NOT NULL,
        vector_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE UNIQUE INDEX IF NOT EXISTS asset_embeddings_identity
      ON asset_embeddings(scope_key, asset_kind, asset_id, model);

      CREATE INDEX IF NOT EXISTS asset_embeddings_lookup
      ON asset_embeddings(scope_key, asset_kind, model);
    `);
  }

  async upsert(entries: readonly VectorIndexEntry[]): Promise<void> {
    if (entries.length === 0) return;
    const updatedAt = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const statement = this.db.prepare(`
        INSERT INTO asset_embeddings
        (scope_key,asset_kind,asset_id,model,content_hash,dim,vector_json,updated_at)
        VALUES (?,?,?,?,?,?,?,?)
        ON CONFLICT(scope_key, asset_kind, asset_id, model) DO UPDATE SET
          content_hash = excluded.content_hash,
          dim = excluded.dim,
          vector_json = excluded.vector_json,
          updated_at = excluded.updated_at
      `);
      for (const entry of entries) {
        statement.run(
          scopeKey(entry.scope),
          entry.kind,
          entry.assetId,
          this.model,
          contentHash(entry.text),
          entry.vector.length,
          JSON.stringify(entry.vector),
          updatedAt,
        );
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  async remove(kind: AssetKind, assetIds: readonly string[]): Promise<void> {
    if (assetIds.length === 0) return;
    const statement = this.db.prepare(`
      DELETE FROM asset_embeddings WHERE asset_kind = ? AND asset_id = ? AND model = ?
    `);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const assetId of assetIds) statement.run(kind, assetId, this.model);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  async search(query: VectorQuery): Promise<VectorMatch[]> {
    if (query.limit <= 0) return [];
    const rows = this.db.prepare(`
      SELECT asset_id, dim, vector_json FROM asset_embeddings
      WHERE scope_key = ? AND asset_kind = ? AND model = ?
    `).all(scopeKey(query.scope), query.kind, this.model) as DbRow[];
    const matches: VectorMatch[] = [];
    for (const row of rows) {
      const vector = JSON.parse(String(row.vector_json)) as number[];
      if (vector.length !== Number(row.dim)) continue;
      const cosine = cosineSimilarity(query.vector, vector);
      if (Number.isFinite(cosine)) matches.push({ assetId: String(row.asset_id), cosine });
    }
    // 排序确定性：余弦降序，平分时按资产 ID 升序
    matches.sort((a, b) => b.cosine - a.cosine || (a.assetId < b.assetId ? -1 : a.assetId > b.assetId ? 1 : 0));
    return matches.slice(0, query.limit);
  }

  async fingerprints(scope: Scope, kind: AssetKind): Promise<{ assetId: string; contentHash: string }[]> {
    const rows = this.db.prepare(`
      SELECT asset_id, content_hash FROM asset_embeddings
      WHERE scope_key = ? AND asset_kind = ? AND model = ?
    `).all(scopeKey(scope), kind, this.model) as DbRow[];
    return rows.map((row) => ({ assetId: String(row.asset_id), contentHash: String(row.content_hash) }));
  }
}

/** 作用域行键：与主库 IFNULL(session_id,'') 的作用域匹配语义一一对应。 */
function scopeKey(scope: Scope): string {
  return `${scope.userId}|${scope.teamId}|${scope.agentId}|${scope.sessionId ?? ""}`;
}

/** 内容指纹：SHA-256 十六进制前 32 位，足以驱动"内容未变则跳过重嵌"。 */
export function contentHash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 32);
}

/**
 * 余弦相似度：范围 [-1, 1]，任一侧为零向量时返回 0（Mock 零向量语义）。
 * 输入长度不一致或含非有限数值时返回 NaN，由调用方丢弃该行。
 */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length === 0 || a.length !== b.length) return Number.NaN;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < a.length; index += 1) {
    const left = a[index]!;
    const right = b[index]!;
    if (!Number.isFinite(left) || !Number.isFinite(right)) return Number.NaN;
    dot += left * right;
    normA += left * left;
    normB += right * right;
  }
  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  if (denominator === 0) return 0;
  return dot / denominator;
}
