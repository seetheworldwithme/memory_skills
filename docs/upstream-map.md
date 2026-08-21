# Upstream Extraction Map

This project is an architectural extraction, not a byte-for-byte copy. The
following upstream areas informed the new modules.

| New module | TencentDB Agent Memory source concepts |
| --- | --- |
| `src/memory/memory-service.ts` | `core/hooks/auto-capture.ts`, `core/hooks/auto-recall.ts`, `core/record/*` |
| `src/memory/types.ts` | L0 records, L1 memory records, L2 scenes, L3 persona |
| `src/skills/skill-service.ts` | `core/skill/skill-core.ts`, `skill-versioning.ts`, `skill-permission.ts` |
| `src/extraction/interfaces.ts` | `core/record/l1-extractor.ts`, `core/skill/skill-extractor.ts` |
| `src/governance/*` | New implementation derived from the approved governance roadmap |
| `src/storage/sqlite-repository.ts` | `core/store/sqlite.ts`, `core/skill/skill-store.ts` |
| `src/api/http-server.ts` | Minimal replacement for the large Gateway handler surface |

The original Tencent copyright and MIT license are retained in `LICENSE`.

2026-08-21 对上游做了一次全面设计对照，借鉴与不抄的结论见
[上游借鉴结论](./analysis/upstream-borrowing-2026-08-21.md)。

