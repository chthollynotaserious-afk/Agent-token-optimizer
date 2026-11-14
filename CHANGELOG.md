[English](CHANGELOG.md) | [简体中文](CHANGELOG.zh-CN.md)

# Changelog

All notable changes to **Universal Agent Optimizer** (formerly `agent-token-optimizer (v1)`) are documented in this file.

## [2.0.0-alpha.2] - 2026-11-14 (`feature/p2-5-cli-types-sdk`)

### Added
- **CLI Entrypoint (`bin/uao.js`)**: Added `uao proxy`, `uao benchmark`, `uao inspect-ledger`, `--help`, and `--version`, wired via `package.json` `"bin"`.
- **TypeScript Declarations (`types/index.d.ts`)**: Full type coverage for all exports in `src/index.js`, wired via `"types"` and `"exports['.'].types"`.
- **Python Lightweight Proxy Client (`python/uao_client.py`, `python/README.md`)**: Zero-dependency Python 3.9+ stdlib client for `/v1/chat/completions`, `/v1/messages`, `/health`, and `/metrics`, plus OpenAI/LangGraph proxy examples.
- **Ergonomic API & Packaging**: Added `UniversalAgentOptimizer.optimizeRequest()`, default optimizer instantiation in `createProxyServer()`, `"files"` whitelist for clean `npm pack` distribution, and bilingual `README.md` (English) + `README.zh-CN.md` (Simplified Chinese).
- **Verification**: Added `tests/unit/cli-and-types.test.mjs` and `tests/integration/python-client.test.mjs`.

## [2.0.0-alpha.1] - 2026-11-14 (`feature/universal-agent-optimizer`, merged into `main`)

### Added
- **Architecture & Research Docs**: Added `docs/COMPETITOR_AUDIT.md`, `docs/ARCHITECTURE_GAP_ANALYSIS.md`, `docs/DIFFERENTIATION.md`, `docs/ARCHITECTURE.md`, `docs/BENCHMARK.md`, and `docs/ROADMAP.md`.
- **Missing Price Table Fixed**: Added `src/core/model-prices.js` (with `src/model-prices.js` compatibility shim) supporting DeepSeek, OpenAI, Anthropic (cache read/write), Google Gemini, and Local LLMs, plus `LEGACY_CNY_PRICE_TABLE`.
- **Cache-Aware Cost Model (`src/core/cache-economics.js`)**: Computes real `Net Savings = Baseline Cost - (Optimized API Cost + Overhead + Cache Rebuild Penalty)` and explicitly separates `observed` vs `estimated` data.
- **Universal Adapters (`src/adapters/*`)**: Added `BaseAgentAdapter`, `OpenAICompatibleAdapter`, `AnthropicAdapter`, `CustomAgentAdapter`, `MCPToolAdapter`, and `LangGraphAdapter`.
- **Core Differentiators**:
  - `src/core/session-lifecycle.js`: 7-step transactional session rotation with async flush verification, handoff envelope, recovery verification, and automatic rollback.
  - `src/core/invocation-controller.js`: Event deduplication, cooldown/exponential backoff, budget gating, and a guaranteed high-priority bypass channel.
  - `src/core/tool-governance.js`: Scene/role-based tool schema filtering, dead tool removal, and schema jitter detection.
  - `src/core/tool-output-retention.js`: Zero-dependency lossless tool output retention with line-range and keyword retrieval.
  - `src/core/static-context-dedup.js` & `src/core/context-selector.js`: Domain-agnostic static dedup and multi-tenant Fail-Closed Scope ACL.
- **Plugins & Local Proxy**:
  - `src/plugins/state-provider.js`: Optional `StateProvider` interface (`NoopStateProvider` default + `CompanionStateProvider` reference).
  - `src/plugins/compression.js` & `src/plugins/external-optimizer.js`: Single-Compressor Coordinator with quality/cost gates, circuit breaker, and safe fallback adapters for Headroom, context-compress, and RTK.
  - `src/proxy/server.js`: Zero-dependency HTTP transparent proxy (`/v1/chat/completions`, `/v1/messages`, `/health`, `/metrics`).
- **Tests & Simulated Benchmark**: Added unit, integration, legacy regression suites (`tests/`) and 10-scenario simulated benchmark (`tests/benchmark/run-benchmark.mjs`) plus GitHub Actions CI (`.github/workflows/ci.yml`).

### Backward Compatibility
- All legacy root modules (`src/session-rotation.js`, `src/static-context-dedup.js`, `src/token-ledger.js`, `src/proactive-gate.js`, `src/turn-guard.js`, `src/context-selector.js`, etc.) remain intact and verified by `tests/regression/legacy-compat.test.mjs`.
