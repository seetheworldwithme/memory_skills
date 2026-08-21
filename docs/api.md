# Minimal HTTP API

All endpoints accept and return JSON.

All `/v1/*` endpoints except login require
`Authorization: Bearer <MEMORY_SKILLS_ACCESS_KEY>`.

## Login

```http
POST /v1/auth/login
```

```json
{ "accessKey": "configured-access-key" }
```

## Health

```http
GET /health
```

## Capture evidence

```http
POST /v1/evidence
```

```json
{
  "id": "ev-1",
  "scope": { "userId": "u1", "teamId": "t1", "agentId": "a1" },
  "role": "user",
  "content": "Always verify before publishing"
}
```

## Propose memory

```http
POST /v1/memories
```

New memory always starts as Draft.

Inspection uses scoped POST endpoints so identity never depends on URL query
defaults:

```text
POST /v1/memories/get
POST /v1/memories/list
```

## Transition memory

```http
POST /v1/memories/:id/status
```

```json
{ "target": "verified" }
```

hybrid 模式下，状态转换成功后服务端会自动对该资产作用域做一次增量向量同步
（失败只记审计事件，不影响转换结果）；Skill 的状态端点行为相同。

## Recall

```http
POST /v1/recall
```

```json
{
  "query": "publishing",
  "scope": { "userId": "u1", "teamId": "t1", "agentId": "a1" },
  "maxResults": 5,
  "maxTotalChars": 2000
}
```

Draft memory is excluded unless `includeDraft` is explicitly true.

## Unified context recall

```http
POST /v1/context/recall
```

```json
{
  "query": "你是谁",
  "scope": { "userId": "u1", "teamId": "t1", "agentId": "a1" },
  "maxMemoryResults": 5,
  "maxMemoryChars": 4000,
  "maxSkillResults": 3,
  "maxSkillChars": 8000
}
```

The response is a versioned context contract (`contractVersion: 1`). The REST
API and the MCP adapter's `structuredContent` share this exact schema; the MCP
text block is only a compatibility view of the same object. 检索默认走词法排序；
服务端配置 `MEMORY_SKILLS_RETRIEVAL=hybrid` 后按混合排序（词法 + 向量融合），
向量通道故障时自动降级为词法并在 `warnings` 中返回
`RETRIEVAL_DEGRADED_LEXICAL`，召回本身不会失败。`match.strategy` 可能是
`lexical` / `vector` / `hybrid`，详见 `docs/retrieval.md`。

```json
{
  "contractVersion": 1,
  "requestId": "15d1b962-1754-4ea9-8a62-87d6d1aa7b36",
  "query": "你是谁",
  "scope": { "userId": "u1", "teamId": "t1", "agentId": "a1" },
  "memories": [
    {
      "id": "mem-1",
      "score": 0.81,
      "truncated": false,
      "match": { "strategy": "lexical", "score": 0.9, "matchedTerms": ["你是谁"] },
      "content": "…"
    }
  ],
  "skills": [
    {
      "id": "skill-1",
      "truncated": false,
      "match": { "strategy": "lexical", "score": 1, "matchedTerms": ["你是谁"] },
      "content": "…"
    }
  ],
  "budget": {
    "maxMemoryResults": 5,
    "maxMemoryChars": 4000,
    "maxSkillResults": 3,
    "maxSkillChars": 8000,
    "usedMemoryChars": 42,
    "usedSkillChars": 210
  },
  "truncated": false,
  "warnings": []
}
```

Field rules:

- `match` describes how each item was selected: `strategy`, normalized
  `score`, and the query `matchedTerms`. It never exposes storage or SQL
  detail.
- `warnings` reports stable machine-readable codes when something was
  degraded: `MEMORY_BUDGET_TRUNCATED`, `SKILL_BUDGET_TRUNCATED`,
  `MEMORY_RESULTS_DROPPED`, `SKILL_RESULTS_DROPPED`. Empty when nothing was
  truncated or dropped.
- `truncated` is true when any returned item's content was cut by a character
  budget. Items dropped only by result-count budgets additionally produce a
  `*_RESULTS_DROPPED` warning without setting `truncated`.
- Both `memories` and `skills` exclude drafts by default and have independent
  result and character budgets.

Compatibility: additive changes (new optional fields, new warning codes) keep
`contractVersion` unchanged. Removing or renaming fields bumps the version.
This is the preferred contract for agent adapters; the separate Memory and
Skill APIs remain available for focused operations. `query` must contain
searchable, non-whitespace text.

## Delete evidence

```http
DELETE /v1/evidence/:id
```

删除证据并传播到派生资产：来源已消失的 **Verified** 资产默认标记为待复核
（`deprecated`，可通过续期/重新验证恢复），不再直接打入终态 `archived`；
Draft 等其余状态保持不变，其"来源悬空"会在 Skill 质量校验中暴露。
返回每个受影响资产的转换明细：

```json
{
  "evidenceId": "ev-1",
  "memories": [{ "id": "mem-1", "from": "verified", "to": "deprecated" }],
  "skills": [{ "id": "skill-1", "from": "draft", "to": "draft" }]
}
```

## Evidence deletion impact（删除前影响预览）

```http
POST /v1/evidence/:id/impact
```

```json
{ "scope": { "userId": "u1", "teamId": "t1", "agentId": "a1" } }
```

只读预览：返回证据本体（含截断预览）与全部派生 Memory/Skill，以及每个资产
删除后将转换到的状态（`wouldTransitionTo`；`null` 表示保持不变），
`pendingReviewCount` 汇总将进入待复核的 Verified 资产数。不改动任何数据。

## Get evidence by ids

批量获取证据原文（严格限定作用域）；供 Web 控制台在审核 Draft 时对照来源。

```http
POST /v1/evidence/get
```

```json
{
  "scope": { "userId": "u1", "teamId": "t1", "agentId": "a1" },
  "ids": ["ev-1", "ev-2"]
}
```

返回 `{ "items": [Evidence] }`；不在该作用域内的 ID 会被静默过滤。

## Submit feedback（显式反馈）

```http
POST /v1/feedback
```

```json
{
  "assetKind": "memory",
  "assetId": "mem-1",
  "scope": { "userId": "u1", "teamId": "t1", "agentId": "a1" },
  "kind": "incorrect",
  "requestId": "0f6b2c1e-…",
  "comment": "与用户最新说法矛盾"
}
```

四类反馈：`useful`（有用）/ `irrelevant`（无关）/ `incorrect`（错误）/
`outdated`（过期）。服务端提交时解析资产当前版本一并落库（Skill 为版本号，
Memory 为 `governance.updatedAt`），`requestId` 关联 `/v1/context/recall`
响应中的召回请求，`comment` 可选。约束：

- 反馈只用于离线评测与治理建议，**不自动改写**资产内容或状态；
- 资产必须存在于该作用域内，否则 `404 NOT_FOUND`；
- 资产后续被归档或删除后反馈记录仍保留（评测样本与治理建议的历史依据）。

## List feedback

```http
POST /v1/feedback/list
```

```json
{ "scope": { "userId": "u1", "teamId": "t1", "agentId": "a1" } }
```

返回 `{ "items": [FeedbackRecord] }`，按创建时间倒序，仅含该作用域内的反馈。

## Sync vector index（人工触发的向量索引同步）

```http
POST /v1/retrieval/sync
```

```json
{
  "scope": { "userId": "u1", "teamId": "t1", "agentId": "a1" },
  "includeDraft": false
}
```

治理状态转换（Verify/Reject/归档等）成功后服务端已自动增量同步该资产作用域，
本端点保留用于初始化索引、更换 Embedding 模型后补齐、或自动同步失败后的补救。
仅当服务端以 `MEMORY_SKILLS_RETRIEVAL=hybrid` 启动并成功装配 Embedding
Provider 时可用，否则返回 `503 EMBEDDING_CONFIG_ERROR`。同步只把该作用域内
可召回（已通过治理过滤）资产的最新正文写入向量索引：

- 内容指纹未变的资产跳过重嵌（增量）；
- 已归档/删除资产的向量行会被清理；
- 返回计数报告（`scanned` / `embedded` / `unchanged` / `removed`），不含任何正文。

```json
{
  "model": "text-embedding-3-small",
  "scope": { "userId": "u1", "teamId": "t1", "agentId": "a1" },
  "memories": { "scanned": 42, "embedded": 5, "unchanged": 37, "removed": 1 },
  "skills": { "scanned": 8, "embedded": 2, "unchanged": 6, "removed": 0 }
}
```

## Run memory proposals（人工触发的记忆提案）

```http
POST /v1/proposals/memory/run
```

```json
{
  "scope": { "userId": "u1", "teamId": "t1", "agentId": "a1" },
  "evidenceIds": ["ev-1"],
  "maxEvidence": 20
}
```

- `evidenceIds` 可省略：默认取该作用域最近 20 条证据（时间倒序）；
- 调用 LLM Provider 提取记忆候选，经校验（占位、敏感信息、来源、去重）后**只创建 Draft**；
- 报告包含 `model`、`promptVersion`、`inputEvidenceIds`、`created`（Draft 列表）、`rejected`（候选被拒原因）、`usage`、`attempts`、`latencyMs`；
- 没有可用证据时不调用模型，直接返回空报告；
- 服务端未配置可用的 LLM Provider 时返回 `503 LLM_CONFIG_ERROR`。

## Run skill proposals（人工触发的 Skill 提案）

```http
POST /v1/proposals/skill/run
```

请求与响应结构与记忆提案相同；模型输出完整的 SKILL.md 候选，校验通过后同样只创建 Draft。

治理边界：无论模型输出什么，提案 API 永不直接产生 Verified 资产；发布只能通过既有的
`POST /v1/memories/:id/status` 与 `POST /v1/skills/:id/status` 由人工完成。

## Skills

```text
POST /v1/skills
POST /v1/skills/get
POST /v1/skills/list
PUT  /v1/skills/:id
POST /v1/skills/:id/status
POST /v1/skills/search
```

Skill updates require `expectedVersion`. A stale version returns HTTP 409.
`PUT /v1/skills/:id` 可选传 `description`（与内容 frontmatter 一并更新）；
创建与更新都会拒绝包含疑似密钥等敏感信息的内容。

## Skill lifecycle（质量校验、版本差异、回滚、使用记录）

```text
POST /v1/skills/:id/validate      质量校验报告
POST /v1/skills/:id/versions      版本历史（新版本在前）
POST /v1/skills/:id/diff          语义化版本差异
POST /v1/skills/:id/rollback      回滚（追加为新 Draft）
POST /v1/skills/:id/runs          记录使用事件
POST /v1/skills/:id/run-summary   使用效果汇总
```

- `validate`：校验名称、描述、触发条件、步骤、失败处理、验证方式、来源和
  敏感信息。错误（error）表示不建议 Verify 的硬伤（格式、占位、敏感信息、
  来源悬空）；警告（warning）表示质量短板，由人决定是否放行。只产出报告，
  不阻塞治理操作。
- `versions`：每个版本携带被替换时的治理状态快照（`status`，历史表升级前的
  版本可能为 `null`）。
- `diff`：默认对照"最近一个已发布版本"（状态快照为 verified/deprecated 的
  最大历史版本）与当前版本；可显式传 `fromVersion`/`toVersion`。结果按
  frontmatter 字段与正文章节两个层面给出增删改与行级明细，附中文摘要。
- `rollback`：`{ "targetVersion": 1 }` 把历史版本内容追加为**新 Draft 版本**
  （历史版本永不覆盖），仍需人工 Verify；来源沿用当前仍存在的证据。
- `runs`：`event` 四选一（`recalled` 被召回 / `adopted` 被采用 /
  `succeeded` 任务成功 / `failed` 任务失败），可关联 `requestId` 与 `note`。
- `run-summary`：使用事件计数 + 关联反馈四分类计数 + 确定性结论
  （`no-evidence` / `supported` / `mixed` / `contradicted`）。
  **没有使用证据时不宣称 Skill 有效**；记录只用于评测与治理建议，
  不自动改写资产。

## Governance（冲突、过期与保留策略）

```text
POST /v1/governance/conflicts
POST /v1/governance/retention/review
POST /v1/governance/retention/deprecate-expired
POST /v1/governance/memories/:id/renew
```

- `conflicts`：确定性扫描（不调用模型）同一作用域内的 Verified 资产：
  归一化内容一致或互相包含 → `duplicate`；检索词重合度 ≥ 0.6 但内容不同 →
  `conflict`（疑似矛盾）。任务 ID 确定（kind + 资产 ID），按需计算不落库；
  处置其中一条资产后任务自动消失。Skill 只比较正文章节（frontmatter 的
  name/description 不同不参与重复判断）。
- `retention/review`：过期待复核清单（`validUntil` 已过但仍为 Verified 的
  记忆）与长期未验证清单（默认 90 天，`staleDays` 可调；仅提示，无自动动作）。
- `retention/deprecate-expired`：把过期 Verified 记忆降权为 `deprecated`
  （待复核），**绝不物理删除**；幂等，重复执行无副作用。
- `memories/:id/renew`：用户确认续期。`validUntil` 传 ISO 日期延长有效期，
  传 `null` 清除期限（长期有效）；若资产此前因过期被降权，自动恢复
  `verified`。仅 Verified/Deprecated 资产可续期。
