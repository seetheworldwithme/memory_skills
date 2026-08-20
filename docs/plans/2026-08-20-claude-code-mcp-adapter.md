# Claude Code MCP Adapter Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Connect the platform-neutral Memory and Skill services to real Claude Code through a read-only stdio MCP adapter, with unified context recall that handles the verified Chinese pronoun test case.

**Architecture:** Keep Memory, Skill, retrieval, governance, and HTTP contracts independent of any agent platform. Add a unified `ContextService` and `/v1/context/recall` application endpoint, then implement a thin stdio MCP adapter that calls the HTTP API. Claude-specific invocation policy lives in `CLAUDE.md`; later Codex, OpenCode, and Pi integrations reuse the same API and MCP tools.

**Tech Stack:** TypeScript, Node.js 22, SQLite, Node test runner, Model Context Protocol TypeScript SDK v2, Zod v4, Claude Code CLI.

---

### Task 1: Deterministic multilingual lexical retrieval

**Files:**
- Create: `src/retrieval/text-match.ts`
- Modify: `src/memory/memory-service.ts`
- Modify: `src/skills/skill-service.ts`
- Test: `tests/sqlite-services.test.ts`

1. Add failing service tests proving query `你是谁` matches verified content containing `我是谁`, while unrelated Chinese text does not match.
2. Run the focused test and confirm the expected empty-result failure.
3. Implement shared deterministic term extraction using word tokens plus normalized CJK phrase windows that reject incidental common bigrams without diluting matches inside full prompts.
4. Reuse the matcher in Memory and Skill search.
5. Run the focused and complete server test suites.

### Task 2: Unified context application API

**Files:**
- Create: `src/context/context-service.ts`
- Create: `src/context/types.ts`
- Modify: `src/api/http-server.ts`
- Modify: `src/index.ts`
- Modify: `docs/api.md`
- Test: `tests/context-service.test.ts`
- Test: `tests/http-api.test.ts`

1. Add failing tests for a single request returning independently budgeted verified memories and skills in the same scope.
2. Implement `ContextService.recall` by composing the existing domain services without adding Claude-specific policy.
3. Expose `POST /v1/context/recall` behind existing Bearer authentication.
4. Document request and response contracts.
5. Run focused and complete server tests.

### Task 3: Read-only MCP adapter

**Files:**
- Create: `src/adapters/mcp/http-client.ts`
- Create: `src/adapters/mcp/server.ts`
- Create: `tests/mcp-http-client.test.ts`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `tsconfig.build.json`
- Modify: `README.md`

1. Install the official MCP server package and Zod v4.
2. Add failing adapter-client tests for authenticated context recall, HTTP errors, and missing configuration.
3. Implement a small authenticated HTTP client.
4. Register read-only `recall_context`, `recall_memory`, `search_skills`, and `get_skill` tools with read-only annotations and structured JSON output.
5. Add an `mcp` script that runs the built stdio entrypoint; keep stdout exclusively for MCP protocol traffic.
6. Build and exercise the adapter with an MCP client/inspector-compatible test.

### Task 4: Claude Code project integration and real acceptance

**Files:**
- Create: `CLAUDE.md`
- Create: `.mcp.json`
- Modify: `.env.example`
- Modify: `.gitignore`
- Modify: `README.md`

1. Add a project MCP configuration that expands `MEMORY_SKILLS_URL` and `MEMORY_SKILLS_ACCESS_KEY` from the user's environment instead of committing credentials.
2. Add concise Claude instructions to call `recall_context` for user preferences, identity, prior decisions, and reusable workflows; treat returned Skill documents as instructions only when relevant.
3. Rotate the checked-in example credential to a placeholder.
4. Build the project and restart the local API so the running instance contains the new endpoint.
5. Verify `claude mcp list` and `/mcp` discovery.
6. Run real Claude Code non-interactively with `你是谁`, confirm an MCP tool call occurs, and confirm the answer is grounded in the verified Memory/Skill result.
7. Run the full tests, typecheck, and production build.

### Acceptance criteria

- Existing REST and web behavior remains compatible.
- `POST /v1/context/recall` returns the current verified Memory and Skill for `你是谁` under `local-admin/local/default`.
- Claude Code discovers the project MCP server without embedding secrets in tracked configuration.
- Claude Code calls the unified read-only tool and answers from recalled content.
- No automatic capture, draft proposal, verification, or publication tool is exposed in this milestone.
- The adapter remains usable by future MCP-capable hosts; platform-specific behavior is isolated to `CLAUDE.md` and host configuration.
