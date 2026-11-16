[English](./MEMORY_ARCHITECTURE.md) | [简体中文](./MEMORY_ARCHITECTURE.zh-CN.md)

# UAO 分层记忆架构说明

> **当前状态：** 默认关闭／用户主动启用（`enabled: false` / `memoryEnabled: false`）。UAO Core 保持底层 Provider 无关与零第三方依赖。

## 1. 架构概览与核心原则

UAO 提供**分层记忆感知与记忆编排能力**，但不演变为自主人格或自我身份系统：

- **L1（工作记忆）：** 通过 `SessionLifecycleController` 提供滑窗交接与召回提示（[src/core/session-lifecycle.js](../src/core/session-lifecycle.js)）。
- **L2（情景记忆）：** 不可变原始证据记录（`kind: 'episodic'`），包含 `source_refs`、`provenance`、`epistemic_status` 与 `content_hash`（[src/memory/schema.js](../src/memory/schema.js)）。
- **L3（语义与叙事状态）：** 派生、版本化的事实与 RP 叙事状态（`semantic`、`narrative_state`），永远不得覆盖原始 L2 记录。
- **L4（联想记忆）：** 轻量级范围隔离关联索引（`MemoryAssociationIndex`，[src/memory/association.js](../src/memory/association.js)），默认禁止跨范围遍历。
- **L5（索引、摘要与检查点）：** 可重建的派生摘要与检查点（`summary`、`checkpoint`、`index`）。

## 2. Provider 与 Adapter 契约

- **Provider 契约（`MemoryProvider`）：** `capabilities()`、`health()`、`writeRecord()`、`readRecord()`、`queryRecords()`、`updateDerivedRecord(id, patch, expectedVersion, scope)`、`listSources()`、`deleteRecords()`、`exportBundle()`、`importBundle()`。
- **参考实现（`InMemoryMemoryProvider`）：** 零依赖内存实现，适用于测试与轻量运行环境（[src/memory/provider-contract.js](../src/memory/provider-contract.js)）。
- **RP / SillyTavern 适配器（`RPMemoryAdapter`）：** 按 `runtime_instance_id`、`character_id`、`chat_id`、`world_id`、`branch_id`、`timeline_id` 严格隔离，完整保留宿主消息顺序，并在 Provider 故障时安全退回 `passthrough` 模式（[src/memory-adapters/rp-adapter.js](../src/memory-adapters/rp-adapter.js)）。

## 3. 范围隔离、隐私保护与备份恢复

- **Fail-Closed 范围授权（`canAccessMemoryScope`）：** 缺失范围标识时绝不退化为共享全局键（[src/memory/scope.js](../src/memory/scope.js)）。
- **密钥脱敏（`redactMemorySecrets`）：** 持久化与注入前自动脱敏 Bearer Token、`sk-*`、`ghp_*`、`api_key=...`、`password=...`、`cookie=...`。
- **检索与注入分离：** `MemoryRetriever` 先执行范围过滤再评分，默认剔除低于 `minRelevanceScore` 的无关记忆；`MemoryInjectionPlanner` 独立执行 `maxMemoryTokens` 预算并将注入文本标记为不可信参考数据。
- **可审计删除与备份校验：** `executeAuditableDeletion` 向派生记录传播删除并在 `AuditLog` 中仅记录元数据（不记录隐私正文）；`createExportBundle` / `verifyImportBundle` 强制校验 SHA-256 `bundleHash`（[src/memory/deletion-and-backup.js](../src/memory/deletion-and-backup.js)）。

## 4. 兼容性与已知限制

- **已验证：** `InMemoryMemoryProvider`、`MemoryRetriever`、`MemoryInjectionPlanner`、`MemoryConsolidator`、`MemoryAssociationIndex`、`MemoryPolicyEngine` 与 `RPMemoryAdapter` 均已通过单元测试。
- **规划中 / 外部扩展：** 持久化 SQLite/向量 Provider 及 SillyTavern 浏览器扩展实时钩子属于外部适配器，不包含在 UAO Core 中。
