[English](./MEMORY_ARCHITECTURE.md) | [简体中文](./MEMORY_ARCHITECTURE.zh-CN.md)

# UAO Layered Memory Architecture

> **Status:** Opt-in (`enabled: false` / `memoryEnabled: false` by default). UAO Core remains provider-agnostic and zero-dependency.

## 1. Overview & Design Principles

UAO provides **layered-memory awareness and memory orchestration** without becoming an autonomous personality/identity system:

- **L1 (Working Memory):** Tail window & handoff via `SessionLifecycleController` ([src/core/session-lifecycle.js](../src/core/session-lifecycle.js)).
- **L2 (Episodic Memory):** Immutable raw evidence records (`kind: 'episodic'`) with `source_refs`, `provenance`, `epistemic_status`, and `content_hash` ([src/memory/schema.js](../src/memory/schema.js)).
- **L3 (Semantic & Narrative State):** Derived, versioned claims and RP narrative state (`semantic`, `narrative_state`) that never overwrite raw L2 records.
- **L4 (Associative Memory):** Lightweight scoped edge index (`MemoryAssociationIndex` in [src/memory/association.js](../src/memory/association.js)) with no cross-scope traversal by default.
- **L5 (Index, Summary & Checkpoint):** Rebuildable derived summaries/checkpoints (`summary`, `checkpoint`, `index`).

## 2. Provider & Adapter Contract

- **Provider Contract (`MemoryProvider`):** `capabilities()`, `health()`, `writeRecord()`, `readRecord()`, `queryRecords()`, `updateDerivedRecord(id, patch, expectedVersion, scope)`, `listSources()`, `deleteRecords()`, `exportBundle()`, `importBundle()`.
- **Reference Provider (`InMemoryMemoryProvider`):** Zero-dependency in-memory implementation for tests and ephemeral runtimes ([src/memory/provider-contract.js](../src/memory/provider-contract.js)).
- **RP / SillyTavern Adapter (`RPMemoryAdapter`):** Isolates `runtime_instance_id`, `character_id`, `chat_id`, `world_id`, `branch_id`, `timeline_id`, preserves host message order, and falls back to `passthrough` on provider failure ([src/memory-adapters/rp-adapter.js](../src/memory-adapters/rp-adapter.js)).

## 3. Scope Isolation, Privacy & Backup

- **Fail-Closed Scope (`canAccessMemoryScope`):** Missing scope identifiers never collapse into a shared global key ([src/memory/scope.js](../src/memory/scope.js)).
- **Secret Redaction (`redactMemorySecrets`):** Strips Bearer tokens, `sk-*`, `ghp_*`, `api_key=...`, `password=...`, and `cookie=...` before persistence and injection.
- **Retrieval vs Injection Separation:** `MemoryRetriever` filters by scope first, then ranks and drops irrelevant items below `minRelevanceScore`. `MemoryInjectionPlanner` separately enforces `maxMemoryTokens` and wraps injected text as untrusted reference data.
- **Auditable Deletion & Backup/Restore:** `executeAuditableDeletion` propagates deletion to derived records and logs metadata (never private content) to `AuditLog`. `createExportBundle` / `verifyImportBundle` enforce SHA-256 `bundleHash` integrity ([src/memory/deletion-and-backup.js](../src/memory/deletion-and-backup.js)).

## 4. Compatibility & Known Limitations

- **Verified:** `InMemoryMemoryProvider`, `MemoryRetriever`, `MemoryInjectionPlanner`, `MemoryConsolidator`, `MemoryAssociationIndex`, `MemoryPolicyEngine`, and `RPMemoryAdapter` are verified in unit tests.
- **Planned / External:** Persistent SQLite/vector providers and live SillyTavern browser-extension hooks are external adapters not bundled in UAO Core.
