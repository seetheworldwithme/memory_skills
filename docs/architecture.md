# Architecture

## Boundary

`memory-skills` is a local modular monolith extracted from the Chat Memory and
Skill concepts in TencentDB Agent Memory. The extraction intentionally keeps
domain semantics and removes platform-specific infrastructure.

```text
HTTP API
  ├── ContextService
  │     └── unified Memory + Skill recall
  ├── MemoryService
  │     ├── L0 evidence
  │     ├── governed L1/L2/L3 assets
  │     ├── scoped recall
  │     └── deletion impact
  ├── SkillService
  │     ├── Draft-first creation
  │     ├── optimistic versions
  │     ├── lifecycle transitions
  │     └── scoped search
  └── SQLiteRepository
        ├── evidence
        ├── memory_assets + source links
        └── skills + immutable versions
```

## Retained concepts

- L0 evidence and L1/L2/L3 memory layers
- user/team/agent/session scope
- source-aware memory assets
- bounded recall
- versioned SKILL.md documents
- optimistic version checks
- explicit lifecycle transitions
- storage and extractor interfaces

## Redesigned concepts

- LLM extractors propose drafts and cannot publish directly.
- Verified is the default minimum status for recall and Skill routing.
- Every memory asset requires source evidence.
- Evidence deletion archives directly derived memory instead of silently
  leaving it active.
- Recall budgets are part of the service API instead of optional prompt-only
  conventions.
- Structured domain errors are translated at the HTTP boundary.

## Intentionally excluded

- TencentDB and TCVDB clients
- COS and STS
- Redis queues and distributed locks
- Kafka, ClickHouse, Langfuse, and OpenTelemetry wiring
- OpenClaw and Hermes adapters
- cloud-specific metadata and quota services
- automatic LLM publishing

These can be added as adapters after the domain and governance contracts have
stabilized.

## Current milestone limitations

- Search is deterministic lexical scoring, not BM25 or vector retrieval.
- CJK retrieval is deterministic rather than semantic or embedding-based.
  Recall uses normalized three-character phrase
  windows (and exact two-character queries) so full prompts are not diluted by
  unrelated words while isolated common bigrams are rejected.
- Extractor interfaces exist, but no model provider is bundled.
- Evidence deletion propagates to directly derived memory. Transitive
  memory-to-memory and memory-to-skill impact graphs are a later milestone.
- `node:sqlite` is built into Node 22+ but currently emits an experimental API
  warning on some Node releases.
- Authentication and network exposure are deliberately absent; bind to
  localhost unless an authentication adapter is added.
