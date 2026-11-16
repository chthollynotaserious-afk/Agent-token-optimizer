[English](./COMPATIBILITY.md) | [简体中文](./COMPATIBILITY.zh-CN.md)

# Compatibility Matrix

This matrix distinguishes **core library capabilities** from **actual integration paths**. A capability is marked `Verified` for an integration path only when backed by an automated test in that path.

> **Important Proxy Limitation:** A transparent HTTP proxy cannot automatically infer every higher-level Agent lifecycle event. Invocation control, transactional session rotation, and identity-aware context ACL require explicit integration signals or hooks from the Agent framework.

## Capability × Integration Path

| Capability | Core API | Generic Proxy | DSH Adapter (`universal-agent-optimizer-dsh`) | Evidence |
|---|---|---|---|---|
| Token ledger (`UniversalTokenLedger`) | Verified | Verified | Verified | [model-prices-ledger.test.mjs](../tests/unit/model-prices-ledger.test.mjs), [external-plugins-proxy.test.mjs](../tests/integration/external-plugins-proxy.test.mjs), [dsh-bundle.test.mjs](../tests/integration/dsh-bundle.test.mjs) |
| Cache-aware cost gate (`analyzePrefixStability`, `evaluateOptimizationEconomics`) | Verified | Verified | Verified | [cache-economics.test.mjs](../tests/unit/cache-economics.test.mjs), [dsh-bundle.test.mjs](../tests/integration/dsh-bundle.test.mjs) |
| Tool schema governance (`ToolGovernance`) | Verified | Partial (when request includes `tools` & scene headers) | Partial (via `ctx.uao.prepareRequest`; direct DSH tool-registry hook Planned) | [tool-governance-dedup-acl.test.mjs](../tests/unit/tool-governance-dedup-acl.test.mjs) |
| Invocation control (`InvocationController`) | Verified | Unsupported (no framework wakeup signal over raw HTTP) | Planned | [invocation-retention-state.test.mjs](../tests/unit/invocation-retention-state.test.mjs) |
| Transactional session rotation (`SessionLifecycleManager`) | Verified | Unsupported (requires host session persistence & flush hooks) | Planned | [session-lifecycle.test.mjs](../tests/unit/session-lifecycle.test.mjs) |
| Context ACL (`selectUniversalContext`) | Verified | Unsupported (requires caller identity & scope metadata) | Planned | [tool-governance-dedup-acl.test.mjs](../tests/unit/tool-governance-dedup-acl.test.mjs) |
| External optimizer coordination (`SingleCompressorCoordinator`) | Verified | Verified | Partial (available on `ctx.uao.optimizer`) | [external-plugins-proxy.test.mjs](../tests/integration/external-plugins-proxy.test.mjs) |
| DSH bundle recognition & Cordis lifecycle (`dsh.bundle.patch`) | N/A | N/A | Verified (`@deepseek-ai/dsh@0.2.1-rc.5`) | [dsh-bundle.test.mjs](../tests/integration/dsh-bundle.test.mjs) |

## Status Definitions

- **Verified:** Covered by passing automated unit/integration tests in this repository.
- **Partial:** Core logic works when the caller supplies the required metadata/headers, or is exposed on `ctx.uao` without automatic host interception.
- **Mock-only:** Tested only against simulated or mocked backends (e.g., simulated benchmark spend).
- **Unsupported:** Not possible or not supported in this integration path without framework-level signals.
- **Planned:** Designed in architecture, not yet wired or tested in this path.
