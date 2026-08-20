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
text block is only a compatibility view of the same object.

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
