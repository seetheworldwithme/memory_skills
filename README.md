# memory-skills

An unofficial, governance-first derivative of
[TencentDB Agent Memory](https://github.com/TencentCloud/TencentDB-Agent-Memory).

This project extracts the Chat Memory and Skill domains into a standalone
TypeScript service. It retains the MIT-licensed design lineage while removing
TencentDB, COS, Redis, Kafka, ClickHouse, OpenClaw, and other platform-specific
runtime dependencies from the core.

## First milestone

- SQLite-backed L0 evidence and L1/L2/L3 governed assets
- Draft/Verified/Deprecated/Rejected/Archived lifecycle
- Source references and derivation links
- Scope-aware recall with character budgets
- Versioned Skill documents with optimistic concurrency
- Minimal local HTTP API
- Access-key protected web console with only Chat Memory and Skill pages
- Unified, platform-neutral context recall for Memory and Skill routing
- Read-only stdio MCP adapter for Claude Code and other MCP-capable agents
- Proposal interfaces for future LLM extraction; no direct auto-publishing

## Commands

```bash
npm install
npm --prefix web install
npm test
npm run typecheck
npm run build
MEMORY_SKILLS_ACCESS_KEY='replace-with-a-long-random-key' npm start
```

Open `http://127.0.0.1:8421` and sign in with the same value configured in
`MEMORY_SKILLS_ACCESS_KEY`. The service defaults to `127.0.0.1:8421`, stores
data in `./data/memory-skills.db`, and serves the production web build from
`./web/dist`.

For frontend development, run the API and Vite dev server separately:

```bash
MEMORY_SKILLS_ACCESS_KEY='dev-only-key' npm run dev
npm run dev:web
```

The first web milestone uses one local administrator scope
(`local-admin/local/default`). It deliberately does not include registration,
multiple users, teams, password recovery, or role-based authorization.

## Claude Code MCP

Build and start the API, then launch Claude Code from this project with the
same access key in its environment:

```bash
npm run build
MEMORY_SKILLS_ACCESS_KEY='replace-with-your-key' npm start

export MEMORY_SKILLS_URL='http://127.0.0.1:8421'
export MEMORY_SKILLS_ACCESS_KEY='replace-with-your-key'
claude
```

The project-level `.mcp.json` starts `dist/adapters/mcp/server.js`. Use `/mcp`
inside Claude Code to approve and inspect the `memory-skills` server. The
adapter exposes four read-only tools: `recall_context`, `recall_memory`,
`search_skills`, and `get_skill`. `CLAUDE.md` tells Claude when to use the
unified tool; `.claude/settings.json` pre-authorizes only that unified read-only
tool. The adapter binds all calls to its configured scope and never exposes
Draft content. Retrieval and governance rules remain in the core service.

For a private machine-specific registration instead of `.mcp.json`, run:

```bash
claude mcp add memory-skills --scope local \
  --env MEMORY_SKILLS_URL="$MEMORY_SKILLS_URL" \
  --env MEMORY_SKILLS_ACCESS_KEY="$MEMORY_SKILLS_ACCESS_KEY" \
  -- node "$PWD/dist/adapters/mcp/server.js"
```

## SessionEnd 半自动捕获（Evidence 层）

有价值对话无需再手动 POST：`scripts/session-end-capture.mjs` 在 Claude Code
会话结束时读取转录文件，把用户消息与助手回复的摘要自动送入
`POST /v1/evidence`。治理边界不变：hook 只自动捕获证据，提案仍需人工触发
`POST /v1/proposals/*/run`，审核仍必须人工 Verify。

在项目级 `.claude/settings.json`（或用户级 `~/.claude/settings.json`）中挂载：

```json
{
  "hooks": {
    "SessionEnd": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node /absolute/path/to/memory_skills/scripts/session-end-capture.mjs"
          }
        ]
      }
    ]
  }
}
```

运行环境需提供 `MEMORY_SKILLS_URL` 与 `MEMORY_SKILLS_ACCESS_KEY`（作用域变量
`MEMORY_SKILLS_USER_ID` 等可选，默认与 MCP 适配器一致）。证据 ID 携带内容指纹：
同一会话重复触发且摘要未变时幂等。hook 任何失败都静默退出，不影响会话收尾。

## Hybrid retrieval（混合检索）

服务默认词法检索；配置 `MEMORY_SKILLS_RETRIEVAL=hybrid` 并配齐 Embedding
环境变量后，`/v1/context/recall` 走词法 + 向量双通道确定性融合，向量故障自动
降级为词法。记忆/Skill 的治理状态转换（Verify/Reject/归档等）成功后会自动
增量同步向量索引，新 Verify 的资产即时进入向量通道；`POST /v1/retrieval/sync`
保留用于初始化、换模型后补齐或自动同步失败后的补救。
设计、环境变量与启用门槛见 `docs/retrieval.md`。

## Attribution

Portions of the architecture and domain semantics are derived from TencentDB
Agent Memory, Copyright (C) 2026 Tencent, under the MIT License. This fork is
not an official Tencent product and does not imply Tencent endorsement.
