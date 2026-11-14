[English](ROADMAP.md) | [简体中文](ROADMAP.zh-CN.md)

# Universal Agent Optimizer Roadmap

- **Baseline:** `1.0.0` (Author Agent production extraction baseline)
- **Current Milestone:** `2.0.0-alpha.2` (P0 + P1 + P2-1~P2-3 + P2-5 implemented & verified locally; P2-4 live empirical benchmarks pending user-provided API credentials)
- **Guiding Principle:** Build verifiable infrastructure first (P0), deliver core lifecycle/economics differentiators (P1), then expand ecosystem & SDK/CLI packaging (P2)—while maintaining 100% backward compatibility with legacy `Opt-1 ~ Opt-5`.

---

## P0: Infrastructure & Verifiable Baseline (Completed)

| ID | Deliverable | Scope | Acceptance Criteria | Status |
|---|---|---|---|---|
| **P0-1** | Price Table & Universal Ledger | `src/core/model-prices.js` (+ `src/model-prices.js` shim); `src/observability/{token-ledger,cost-tracker,cache-tracker,audit-log}.js` | Legacy `token-ledger.js` & `tool-cost-attribution.js` import cleanly; OpenAI/Anthropic/DeepSeek/Gemini normalization | Done |
| **P0-2** | Cache-Aware Cost Model | `src/core/cache-economics.js` separating `observed` vs `estimated`, calculating Net Savings & cache rebuild penalty | Unit tests cover hit/miss spread & negative net-savings rejection | Done |
| **P0-3** | Universal Adapters & Orchestrator | `src/adapters/{base,openai-compatible,anthropic,custom-agent}.js`, `src/core/{optimizer,tool-governance}.js` | Simulated agents complete request/tool/response cycles via adapters | Done |
| **P0-4** | Legacy Opt-1~5 Compatibility | `tests/regression/legacy-compat.test.mjs` replacing false-green `test_cost_calc.mjs` | Zero regressions across all v1 exports & semantics | Done |
| **P0-5** | Quality Regression Benchmark | `tests/benchmark/run-benchmark.mjs` (10 simulated scenarios, zero real API spend) | Deterministic Baseline vs Optimized output clearly tagged `simulated` | Done |

---

## P1: Core Differentiators (Completed)

| ID | Deliverable | Scope | Acceptance Criteria | Status |
|---|---|---|---|---|
| **P1-1** | Transactional Session Lifecycle | `src/core/session-lifecycle.js`: 7-step lock -> await flush -> verify -> handoff -> activate -> verify recovery -> rollback | Fault injection verifies 100% rollback when flush or recovery fails | Done |
| **P1-2** | Autonomous Invocation Controller | `src/core/invocation-controller.js`: coalesce/dedup, cooldown backoff, budget gate, **urgent bypass** | Filters low-value idle wakes with 0% false drop on urgent events | Done |
| **P1-3** | Tool Result Retention & Recovery | `src/core/tool-output-retention.js`: local raw storage + line-range / keyword retrieval | Exact slice & keyword recovery on oversized outputs | Done |
| **P1-4** | Optional StateProvider Interface | `src/plugins/state-provider.js`: `NoopStateProvider` (default) + `CompanionStateProvider` | Core runs statelessly with zero persona/emotion dependencies | Done |
| **P1-5** | Universal Context Selector & ACL | `src/core/context-selector.js`: generalized Fail-Closed multi-tenant Scope ACL | 100% isolation block rate across tenants/scopes | Done |

---

## P2: Ecosystem, Proxy, Empirical Benchmarks & Packaging

| ID | Deliverable | Scope | Acceptance Criteria | Status |
|---|---|---|---|---|
| **P2-1** | Single-Compressor + Plugins | `src/plugins/{compression,external-optimizer}.js` (`HeadroomPlugin`, `ContextCompressPlugin`, `RTKPlugin` + `CircuitBreaker`) | Prevents double compression; 100% fallback on mock outage/timeout | Done (local mocks) |
| **P2-2** | Local HTTP Transparent Proxy | `src/proxy/server.js` (`/v1/chat/completions`, `/v1/messages`, `/health`, `/metrics`) | Integration tests verify proxy interception & ledger accounting | Done (local stub) |
| **P2-3** | MCP & LangGraph Adapters | `src/adapters/mcp.js`, `src/adapters/langgraph.js` | Simulated MCP tool & LangGraph node tests pass | Done |
| **P2-4** | Live Empirical Third-Party Benchmark | Live comparison against Headroom / ContextPilot / context-compress under user-approved API budget | Audited `empirical` comparison report with real `observed` billing | Pending (needs API credentials / local external daemons) |
| **P2-5** | npm Packaging, `.d.ts`, CLI & Python Client | `package.json` `exports`/`bin`/`types`, `types/index.d.ts`, `bin/uao.js`, `python/uao_client.py` | Clean `npm pack` install, export-parity test, and Python proxy client test pass | In Progress (current branch) |
