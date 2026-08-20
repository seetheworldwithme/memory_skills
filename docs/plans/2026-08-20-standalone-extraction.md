# Standalone Memory and Skills Extraction Plan

**Goal:** Extract the reusable Chat Memory and Skill domain into a standalone TypeScript service with governance-first semantics.

**Architecture:** A dependency-light modular monolith. SQLite stores evidence, governed memory assets, skill versions, and derivation links. Domain services own lifecycle rules; an HTTP adapter exposes a minimal API; LLM extraction remains behind interfaces.

**Tech Stack:** TypeScript, Node.js 22+, built-in `node:sqlite`, built-in HTTP server, Node test runner, tsx.

---

### Task 1: Project boundary and licensing

- Add the original MIT license and Tencent copyright notice.
- Mark the project as an unofficial derivative.
- Configure TypeScript, tests, build, and package exports.

### Task 2: Governance domain

- Define Draft, Verified, Deprecated, Rejected, and Archived states.
- Define source references, confidence, scope, and derivation links.
- Test legal and illegal state transitions.

### Task 3: SQLite persistence

- Create evidence, memory asset, skill, skill version, and derivation tables.
- Keep storage behind repository interfaces.
- Test persistence and isolation with temporary databases.

### Task 4: Chat Memory service

- Capture L0 evidence idempotently.
- Create governed L1/L2/L3 assets with sources.
- Recall only eligible assets with scope and budget enforcement.
- Cascade or review derived assets when evidence is deleted.

### Task 5: Skill service

- Create Draft skills with validated frontmatter.
- Update skills using optimistic versions.
- Verify, reject, deprecate, archive, search, and inspect sources.
- Keep automatic extraction behind a proposal interface; it must not publish directly.

### Task 6: Minimal HTTP API

- Expose health, evidence capture, memory CRUD/recall, skill CRUD/search, and governance transitions.
- Return structured errors and never expose internal stack traces.

### Task 7: Verification and handoff

- Run tests, typecheck, and build.
- Document what was retained, redesigned, and intentionally excluded.

