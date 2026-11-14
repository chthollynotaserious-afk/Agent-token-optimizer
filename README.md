# Universal Agent Optimizer

**An open-source optimization middleware for long-running AI agents.**

> **Status:** `v2.0.0-alpha.1` on branch `feature/universal-agent-optimizer` (evolved from `denia-token-optimizer`).
>
> Zero-dependency Node.js (`>=20.0.0`) ESM runtime. Fully backward-compatible with all v1 legacy `src/*.js` modules.

Universal Agent Optimizer lowers real API spend, invalid model wakeups, tool bloat, and long-session context inflation for stateful, long-running agents — **without sacrificing task success, breaking KV-cache prefix hits, bypassing tool ACLs, or losing critical memory during session rotation.**

---

## Why Universal Agent Optimizer?

Most existing tools solve **stateless, per-turn prompt compression** or **LLM routing**. Long-running agents fail economically and reliably for different reasons:

| Layer | Existing Ecosystem | Universal Agent Optimizer Differentiator |
|---|---|---|
| **KV-Cache Economics** | Generic token reduction (can accidentally bust cached prefixes and cost *more*) | **Cache-Aware Cost Gate (`src/core/cache-economics.js`)**: computes `Net Savings = Baseline - (Optimized + Overhead + Cache Rebuild Penalty)` and blocks prefix rewrites unless net ROI is positive. |
| **Session Lifecycle** | Hard resets or lossy rolling summaries | **7-Step Transactional Rotation (`src/core/session-lifecycle.js`)**: `await` flush -> verify persistence -> build structured handoff -> reset -> verify recovery -> atomic rollback on failure. |
| **Autonomous Wakeups** | Polls / heartbeats billed at full rate | **Invocation Controller (`src/core/invocation-controller.js`)**: event dedup, cooldown & exponential backoff, budget gates, plus a guaranteed **Priority Bypass** (`urgent` / `user_direct`). |
| **Tool Governance & Output** | All schemas sent every turn; raw stdout truncated blindly | **Tool Governance (`src/core/tool-governance.js`) & Retention Store (`src/core/tool-output-retention.js`)**: scene/role schema pruning, loop/dead-tool guards, lossless line-range/keyword retrieval. |
| **Multi-Tenant Isolation** | Flat context pools | **Fail-Closed Scope ACL (`src/core/context-selector.js`)**: strict scope isolation across users, channels, workspaces, and sub-agents. |
| **External Optimizers** | Isolated tools that fight over the same prefix | **Single-Compressor Coordinator + Circuit Breaker (`src/plugins/compression.js`, `src/plugins/external-optimizer.js`)**: safe adapter integration for Headroom, `context-compress`, and RTK with quality gates and fallback. |

For detailed design rationale and competitive analysis, see [`docs/`](./docs/):
- [Competitor Audit](./docs/COMPETITOR_AUDIT.md)
- [Architecture Gap Analysis](./docs/ARCHITECTURE_GAP_ANALYSIS.md)
- [Differentiation Strategy](./docs/DIFFERENTIATION.md)
- [Universal Architecture](./docs/ARCHITECTURE.md)
- [Benchmark Specification](./docs/BENCHMARK.md)
- [Roadmap](./docs/ROADMAP.md)

---

## Feature Maturity & Honest Boundaries

> [!IMPORTANT]
> **Verified vs. Mocked vs. Future:** We explicitly distinguish what has been executed locally from mocked integrations and planned work.

- **Verified in Local Node.js Tests (Unit + Integration + Legacy Regression):**
  - Core engine: `UniversalAgentOptimizer`, `cache-economics`, `model-prices`, `session-lifecycle`, `invocation-controller`, `tool-governance`, `static-context-dedup`, `tool-output-retention`, `context-selector`
  - Built-in adapters: `BaseAgentAdapter`, `OpenAICompatibleAdapter`, `AnthropicAdapter`, `CustomAgentAdapter`, `MCPToolAdapter`, `LangGraphAdapter`
  - State providers & single-compressor gate: `NoopStateProvider`, `CompanionStateProvider`, `SingleCompressorCoordinator`
  - Observability: `UniversalTokenLedger`, `CostTracker`, `CacheTracker`, `AuditLog`
  - Local HTTP transparent proxy: `createProxyServer` (`/v1/chat/completions`, `/v1/messages`, `/health`, `/metrics`) against a local stub upstream
  - V1 legacy compatibility (`src/session-rotation.js`, `src/static-context-dedup.js`, `src/token-ledger.js`, etc.)
- **Tested Against Local Mocks Only (Pending Live Integration):**
  - External optimizer adapters: `HeadroomPlugin`, `ContextCompressPlugin`, `RTKPlugin` (`src/plugins/external-optimizer.js`) — HTTP/CLI contracts, circuit-breaker failover, and fallback paths are verified against local mocks; live external daemon runs have not yet been executed in CI.
  - Cloud LLM API spend benchmarks — all current benchmarks run in `simulated` mode (`0` live API spend). Real API verification requires explicit user authorization and credentials.
- **Not Included / Out of Scope:**
  - Model routing, billing gateways, and multi-provider auth pools (delegated to gateway layers such as LiteLLM).
  - Real-time RL/model-based token scoring (`LLMLingua`-style local GPU inference).

---

## Quick Start

### 1. Embedded Middleware Mode

```js
import { UniversalAgentOptimizer, OpenAICompatibleAdapter } from 'universal-agent-optimizer';

const optimizer = new UniversalAgentOptimizer({
  adapter: new OpenAICompatibleAdapter(),
});

// Run full request lifecycle: invocation gate -> dedup -> tool pruning -> cache gate -> upstream -> telemetry
const result = await optimizer.optimizeRequest({
  model: 'deepseek-chat',
  sessionId: 'session-1',
  scene: 'coding',
  tools: [
    { name: 'read_file', description: 'Read file lines' },
    { name: 'billing_export', description: 'Export invoice' },
  ],
  messages: [
    { role: 'system', content: 'You are a concise coding assistant.' },
    { role: 'user', content: 'Inspect src/index.js for exports.' },
  ],
  invokeUpstream: async (optimizedPayload) => {
    // Call your OpenAI / Anthropic / local LLM client here
    return {
      content: 'Done.',
      usage: { prompt_tokens: 1200, cached_tokens: 900, completion_tokens: 45 },
    };
  },
});

console.log(result.telemetry);
```

### 2. Local Transparent HTTP Proxy Mode

```js
import { createProxyServer } from 'universal-agent-optimizer';

const proxy = createProxyServer({
  upstreamBaseUrl: 'https://api.openai.com', // or local vLLM/Ollama/Anthropic endpoint
});

await proxy.listen(8787);
// Routes:
//   POST /v1/chat/completions
//   POST /v1/messages
//   GET  /health
//   GET  /metrics
```

---

## Repository Structure

```text
src/
├── index.js                         # Public exports for v2 Universal Agent Optimizer
├── model-prices.js                  # Compatibility shim for legacy token-ledger imports
├── core/
│   ├── optimizer.js                 # Unified optimizeRequest / optimizeTurn pipeline
│   ├── cache-economics.js           # Provider cache profiles & net-savings cost gate
│   ├── model-prices.js              # Multi-provider USD & legacy CNY pricing tables
│   ├── session-lifecycle.js         # 7-step transactional rotation + rollback
│   ├── invocation-controller.js     # Dedup, backoff, budget gate, urgent priority bypass
│   ├── tool-governance.js           # Scene/role filtering, schema hash, loop/dead-tool guards
│   ├── tool-output-retention.js     # Lossless stdout retention + line/keyword retrieval
│   ├── static-context-dedup.js      # Generic fingerprint-based system/reference dedup
│   └── context-selector.js          # Multi-tenant Fail-Closed Scope ACL selection
├── adapters/
│   ├── base.js                      # Provider-neutral NormalizedAgentTurn contract
│   ├── openai-compatible.js         # OpenAI / DeepSeek / OpenRouter / vLLM / Ollama
│   ├── anthropic.js                 # Anthropic Messages + cache_control + cache_read/write
│   ├── custom-agent.js              # Custom Node.js agent loop integration
│   ├── mcp.js                       # MCP tool schema & result metadata normalization
│   └── langgraph.js                 # LangGraph node/state wrapper
├── plugins/
│   ├── state-provider.js            # Optional StateProvider (NoopStateProvider, CompanionStateProvider)
│   ├── compression.js               # Single-Compressor Coordinator + quality/cache gates
│   └── external-optimizer.js        # CircuitBreaker + Headroom / context-compress / RTK plugins
├── observability/
│   ├── token-ledger.js              # Session/model/provider ledger (observed vs estimated)
│   ├── cost-tracker.js              # Net savings attribution & cache rebuild tracking
│   ├── cache-tracker.js             # Prefix stability & cache hit tracking
│   └── audit-log.js                 # Structured optimization decision & ACL audit log
├── proxy/
│   └── server.js                    # Zero-dependency HTTP transparent proxy
└── *.js                             # Original v1 legacy modules (preserved for compatibility)

tests/
├── unit/                            # Core module unit tests
├── integration/                     # Simulated OpenAI/Anthropic/MCP/LangGraph/Proxy & benchmark smoke
├── regression/                      # V1 backward-compatibility & legacy shim verification
└── benchmark/run-benchmark.mjs      # 10-scenario zero-cost simulated benchmark harness

scripts/                             # Original v1 verification scripts
docs/                                # Research, audit, architecture, benchmark, roadmap docs
```

---

## Simulated Benchmark Summary (`S1`–`S10`)

> **Disclaimer:** Results below were measured by running `npm run benchmark` (`node tests/benchmark/run-benchmark.mjs`) in **SIMULATED mode (`ZERO API SPEND`)**. They validate the cost model, cache-gate math, invocation throttling, retention compression, and rotation mechanics deterministically—they do **not** claim empirical live production API savings.

| Scenario | Model | Baseline | Optimized | Net Savings | TaskOK | Regression | Overhead |
|---|---|---:|---:|---:|---:|---:|---:|
| S1: Normal Multi-Turn Chat (10 turns) | `deepseek-chat` | \$0.00626 | \$0.00557 | 11.1% | 100% | 0% | 12.89ms |
| S2: Long Conversation (60 turns) | `deepseek-chat` | \$0.23480 | \$0.03602 | 84.7% | 100% | 0% | 5.69ms |
| S3: Multi-turn Tool Calling & Loop Guard | `gpt-4o-mini` | \$0.01122 | \$0.00285 | 74.6% | 100% | 0% | 1.87ms |
| S4: Large Tool Output & Retention Recovery | `claude-sonnet-4` | \$0.06099 | \$0.01089 | 82.1% | 100% | 0% | 0.93ms |
| S5: Long Coding Agent (30 steps, 80 tools) | `claude-sonnet-4` | \$0.19689 | \$0.17131 | 13.0% | 100% | 0% | 4.19ms |
| S6: Multi-Agent Workflow & Scope ACL | `gpt-4o-mini` | \$0.00324 | \$0.00162 | 50.0% | 100% | 0% | 0.48ms |
| S7: Proactive Wakeups (50 triggers, 5 urgent) | `deepseek-chat` | \$0.34190 | \$0.04103 | 88.0% | 100% | 0% | 0.45ms |
| S8: Session Rotation & Recovery | `deepseek-chat` | \$0.00335 | \$0.00051 | 84.6% | 100% | 0% | 0.17ms |
| S9: Memory Retrieval & Cross-Scope Isolation | `gpt-4o-mini` | \$0.00065 | \$0.00012 | 82.2% | 100% | 0% | 0.18ms |
| S10: Mixed-Model Routing (Claude + GPT-4o-mini Flush) | `claude-sonnet-4` | \$0.05100 | \$0.01959 | 61.6% | 100% | 0% | 0.03ms |

---

## Development & Testing

Requirements: **Node.js >= 20.0.0** (no `npm install` needed; zero runtime dependencies).

```bash
# Run all unit, integration, and legacy compatibility tests
npm test

# Run individual test suites
npm run test:unit
npm run test:integration
npm run test:regression

# Run the 10-scenario zero-cost simulated benchmark
npm run benchmark
```

---

## License

MIT
