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

## Attribution

Portions of the architecture and domain semantics are derived from TencentDB
Agent Memory, Copyright (C) 2026 Tencent, under the MIT License. This fork is
not an official Tencent product and does not imply Tencent endorsement.
