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

The response reports directly derived memory assets that were archived.

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
