# Operations Manual（Task 17：迁移、备份与恢复）

> 面向运维自己的手册：日常怎么备份、出事怎么恢复、升级怎么走、怎么验证。
> 命令默认在仓库根目录执行；数据库默认路径 `data/memory-skills.db`（`MEMORY_SKILLS_DB` 可改）。

## 1. Schema 迁移

### 机制

- 所有 Schema 变更收口在 `src/storage/migrations/`：单向编号迁移（001 核心表 → 002 反馈 → 003 使用记录 → 004 版本状态快照），只允许追加，不允许修改历史迁移。
- 执行器 `src/storage/migration-runner.ts`：每个迁移在独立事务内执行并登记 `schema_migrations` 表；失败即中断，库停留在上一个完整版本，**永不自动回滚**。
- **旧库兼容**：2026-08-21 之前由旧版内联建库的数据库没有迁移登记，执行器按结构指纹（存在哪些表/列）识别基线版本后补登记，不会重放已生效的变更。现有 8421 生产库首次启动新版本时自动完成登记，无感升级。
- **启动前自动备份**：服务启动时若检测到待应用迁移，先在 `MEMORY_SKILLS_BACKUP_DIR`（默认 `data/backups/`）留一份 `pre-migrate-v<from>-to-v<to>-<时间>.db` 快照再升级；全新库自动跳过。
- 向量索引表 `asset_embeddings` 不在迁移链内：它是可重建的派生数据，Schema 变化后用 `POST /v1/retrieval/sync` 重灌即可。

### 新增一个迁移（开发者）

1. 在 `src/storage/migrations/` 追加 `005-<名称>.ts`，id 顺序连续；
2. 在同目录 `index.ts` 注册；
3. `tests/migrations.test.ts` 补一条跨版本升级用例（旧版本子集建库 + 种子数据 → 升级 → 断言）。

### 升级演练（发布前必做）

```bash
# 1. 备份生产库（见下节）
npm run backup

# 2. 用备份副本在临时目录预演升级与恢复全流程（不碰生产库）
node --import tsx scripts/restore.mjs data/backups/<最新>.db.manifest.json --db /tmp/upgrade-drill.db

# 3. 确认无误后停服、替换代码、启动；启动日志会显示迁移应用情况
```

## 2. 备份

```bash
npm run backup                    # 默认 data/memory-skills.db → data/backups/
npm run backup -- --db /path/to/db --out /path/to/backups
```

每次备份产出两个文件：

- `memory-skills-<时间>.db`：`VACUUM INTO` 自包含快照（含 WAL 未合并数据，源库零锁干扰）；
- `memory-skills-<时间>.db.manifest.json`：Schema 版本、内容 sha256、大小、创建时间与恢复命令。

脚本内置自验证：快照产出后立即做 `integrity_check`，不通过则不写 manifest。

**建议频率**：本地个人版每周或每次批量治理操作前；团队版每日（cron/launchd 调 `npm run backup` 即可）。保留策略见 `docs/threat-model.md` §4。

## 3. 恢复

```bash
# 先停服务（运行中的连接持有 WAL，替换会失效甚至损坏）：
#   Ctrl-C 或 kill <pid>，确认进程退出

npm run restore -- data/backups/<备份>.db.manifest.json            # 恢复到默认库
npm run restore -- <备份>.db.manifest.json --db /path/to/target.db # 恢复到指定库
```

恢复流程的安全保证：

1. **manifest 强校验**：没有伴生 manifest 的文件拒绝恢复（防误用来历不明的库）；sha256 比特级一致才继续；
2. **临时库验证**：先恢复到 staging 库，跑迁移升到当前代码 Schema + `integrity_check` + `foreign_key_check`，任何一步失败立即中止且**目标库不受影响**；
3. **保底备份**：替换目标库前，目标原文件自动复制为 `<目标>.pre-restore-<时间>`，恢复错了还能再救回来；
4. 旧目标的 `-wal`/`-shm` 附属文件一并清理，避免新旧混搭。

恢复后重启服务，用 `/health` 和一次 `recall_context` 抽查数据。

## 4. 数据完整性巡检

```bash
node -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync("data/memory-skills.db", { readOnly: true });
console.log("integrity:", db.prepare("PRAGMA integrity_check").get());
console.log("fk violations:", db.prepare("PRAGMA foreign_key_check").all().length);
console.log("schema version:", db.prepare("SELECT max(id) v FROM schema_migrations").get().v);
db.close();'
```

预期：`integrity: ok`、`fk violations: 0`、schema version 等于 `src/storage/migrations/index.ts` 的迁移数。

## 5. 故障速查

| 症状 | 处置 |
| --- | --- |
| 启动报"迁移 N-xxx 失败（库停留在版本 M）" | 库停在完整旧版本，服务可回退旧代码运行；用 pre-migrate 快照 + 升级预演定位失败迁移 |
| restore 报"哈希不匹配" | 备份文件损坏或被篡改，换更早的备份 |
| restore 报"找不到伴生 manifest" | 只接受 backup.mjs 产出；手头的裸 .db 先挂到临时路径用 backup.mjs 重新封装 |
| 误删生产库 | 最后一次 `npm run backup` 的快照 + `npm run restore`；平时备份频率决定损失窗口 |
| 迁移后向量召回为空 | 派生索引重建：`POST /v1/retrieval/sync`（需 write 角色） |

## 6. 与其他文档的关系

- 身份与授权：`docs/security-model.md`
- 威胁建模与日志保留策略：`docs/threat-model.md`
- HTTP API（含治理与审计语义）：`docs/api.md`
