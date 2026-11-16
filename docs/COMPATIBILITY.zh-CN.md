[English](./COMPATIBILITY.md) | [简体中文](./COMPATIBILITY.zh-CN.md)

# 兼容性矩阵

本矩阵明确区分**核心库能力**与**实际接入路径**。只有当某个接入路径拥有对应的自动化测试证据时，才允许标记为 `Verified`。

> **重要代理限制说明：** 透明 HTTP Proxy 无法自动推断所有上层 Agent 生命周期事件。主动调用控制、事务性会话轮转和身份感知上下文 ACL，均需要 Agent 框架提供对应的集成信号或钩子。

## 能力 × 接入路径

| 能力 | 核心 API | 通用 HTTP 代理 | DSH 适配器（`universal-agent-optimizer-dsh`） | 证据 |
|---|---|---|---|---|
| Token 账本（`UniversalTokenLedger`） | Verified | Verified | Verified | [model-prices-ledger.test.mjs](../tests/unit/model-prices-ledger.test.mjs), [external-plugins-proxy.test.mjs](../tests/integration/external-plugins-proxy.test.mjs), [dsh-bundle.test.mjs](../tests/integration/dsh-bundle.test.mjs) |
| Cache 感知成本门控（`analyzePrefixStability`, `evaluateOptimizationEconomics`） | Verified | Verified | Verified | [cache-economics.test.mjs](../tests/unit/cache-economics.test.mjs), [dsh-bundle.test.mjs](../tests/integration/dsh-bundle.test.mjs) |
| 工具 Schema 治理（`ToolGovernance`） | Verified | Partial（仅当请求携带 `tools` 与场景 Header 时） | Partial（通过 `ctx.uao.prepareRequest` 调用；直接挂载 DSH 工具注册钩子为 Planned） | [tool-governance-dedup-acl.test.mjs](../tests/unit/tool-governance-dedup-acl.test.mjs) |
| 主动调用控制（`InvocationController`） | Verified | Unsupported（纯 HTTP 层无框架唤醒信号） | Planned | [invocation-retention-state.test.mjs](../tests/unit/invocation-retention-state.test.mjs) |
| 事务性会话轮转（`SessionLifecycleManager`） | Verified | Unsupported（需要宿主会话持久化与 Flush 钩子） | Planned | [session-lifecycle.test.mjs](../tests/unit/session-lifecycle.test.mjs) |
| 上下文 ACL（`selectUniversalContext`） | Verified | Unsupported（需要调用方提供身份与作用域元数据） | Planned | [tool-governance-dedup-acl.test.mjs](../tests/unit/tool-governance-dedup-acl.test.mjs) |
| 外部优化器协调（`SingleCompressorCoordinator`） | Verified | Verified | Partial（可通过 `ctx.uao.optimizer` 调用） | [external-plugins-proxy.test.mjs](../tests/integration/external-plugins-proxy.test.mjs) |
| DSH Bundle 识别与 Cordis 生命周期（`dsh.bundle.patch`） | N/A | N/A | Verified（`@deepseek-ai/dsh@0.2.1-rc.5`） | [dsh-bundle.test.mjs](../tests/integration/dsh-bundle.test.mjs) |

## 状态定义

- **Verified：** 仓库中已有通过的自动化单元/集成测试覆盖。
- **Partial：** 仅当调用方主动传入所需元数据/Header 时生效，或在 `ctx.uao` 上可用但尚未自动拦截宿主生命周期。
- **Mock-only：** 仅针对模拟或 Mock 后端验证（例如纯模拟的基准测试费用）。
- **Unsupported：** 在缺少框架层信号的情况下，该接入路径无法支持。
- **Planned：** 架构已规划，但尚未在该接入路径完成接线与测试。
