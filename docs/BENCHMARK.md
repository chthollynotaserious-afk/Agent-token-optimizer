[English](BENCHMARK.md) | [简体中文](BENCHMARK.zh-CN.md)

# Universal Optimizer Benchmark Specification

## 1. Core Principles & Anti-Cheating Rules

1. **Never report "token compression ratio" alone:** Always report `Total API Cost`, `Cache Hit/Miss`, `Task Success Rate`, and `Regression Rate` alongside token reduction.
2. **Strict Data Provenance Separation:**
   - `empirical`: real requests sent to live provider endpoints with observed response billing/usage headers.
   - `simulated`: deterministic offline replay using unified token/character estimation + simulated agent state machines + real pricing formulas (`model-prices.js`).
   - `theoretical`: formula-based projections.
   - **Never label `simulated` or `theoretical` numbers as `empirical`; never report scores for uninstalled third-party tools.**
3. **Controlled Variables:** Within each comparison arm, lock **model ID, task suite, tool definitions, model hyperparameters (`temperature`/`max_tokens`), and price table version**.

---

## 2. Ten Standard Benchmark Scenarios

| ID | Scenario Name | Key Workload Characteristics | Primary Verification Metrics |
|---|---|---|---|
| **S1** | Normal Multi-Turn Chat | 8–12 short turns, low tool usage | Optimizer overhead, prefix stability, zero baseline regression |
| **S2** | Long Conversation | 60+ turns with repeated static rules & growing history | Total cost & compaction avalanche prevention (Rotation vs. Compaction) |
| **S3** | Multi-turn Tool Calling | 6–15 tool steps/turn including retry & loop triggers | Turn Guard loop-stop rate, wasted continuation reduction |
| **S4** | Large Tool Output | 20KB–100KB JSON / logs / file output per tool call | Retention compression ratio, on-demand recovery accuracy |
| **S5** | Long Coding Agent | Read -> edit -> test -> debug loops (30+ steps, 80+ tools) | Task Success Rate, Cache Hit Rate, Net Savings |
| **S6** | Multi-Agent Workflow | Coordinator + 2 Workers (shared rules + private scopes) | Zero Scope ACL leaks, cross-agent static dedup |
| **S7** | Proactive Wakeups | 50 scheduled triggers (40 idle + 5 minor + 5 urgent user events) | Zero-output wake suppression, **0% urgent false suppression** |
| **S8** | Session Rotation & Recovery | Rotation at limit followed immediately by anaphora / recall queries | Context recovery integrity, transactional rollback on fault |
| **S9** | Memory Retrieval & Isolation | Multi-tenant / multi-channel pool + sensitive + expired records | Fail-Closed block rate (100%), relevant recall rate |
| **S10** | Mixed-Model Routing | Primary reasoning on frontier model + cheap model for flush/judge | Blended Net Savings, output quality consistency |

---

## 3. Comparison Arms

| Arm | Description | Current Execution Contract |
|---|---|---|
| **Baseline (Unoptimized Agent)** | No context pruning, no rotation, all schemas injected, no wake gate | Runs deterministically (`simulated`) |
| **Agent + Universal Optimizer (Core)** | Opt-1~5 core + Retention + Cache Economics | Runs deterministically (`simulated`); live `empirical` pending user budget |
| **Agent + Headroom** | Integrated via `HeadroomPlugin` (requires local Headroom service/SDK) | Mock contract & circuit-breaker fallback tested when uninstalled |
| **Agent + ContextPilot** | Reference comparator arm (requires local `contextpilot-ai`) | Pending local install |
| **Agent + context-compress** | Mounted via `ContextCompressPlugin` / MCP | Mock contract & fallback tested when uninstalled |
| **Agent + Combined Stack** | Universal Optimizer + external compression plugin | Verifies Single-Compressor Guard (no double compression) & net economics |

---

## 4. Metrics & Formulas

| Metric | Definition / Formula | Source |
|---|---|---|
| **Total API Cost** | $\sum (\text{Miss}\cdot P_{\text{miss}} + \text{Hit}\cdot P_{\text{hit}} + \text{Write}\cdot P_{\text{write}} + \text{Out}\cdot P_{\text{out}})$ | `TokenLedger` + `model-prices.js` |
| **Input / Output Tokens** | Bucketed `cacheMiss`, `cacheHit`, `cacheWrite`, `output`, `reasoning` | Provider `usage` / simulator |
| **Cache Hit / Miss Ratio** | $\text{cacheHit} / (\text{cacheHit} + \text{cacheMiss} + \text{cacheWrite})$ | Same as above |
| **Net Savings** | $\text{Baseline Cost} - (\text{Optimized API Cost} + \text{Optimizer Overhead Cost})$ | `CacheEconomicsEngine` |
| **Task Success Rate** | Passed assertions / total tasks | Deterministic verifier |
| **Context Recovery Rate** | Correct recall rate after rotation or tool-output retention | S4 / S8 probes |
| **Latency & Overhead** | End-to-end + middleware processing time (ms) | `performance.now()` |
| **Regression Rate** | Fraction where Baseline passes and Optimized fails (target $\le 0\%$–$2\%$) | Paired comparator |

---

## 5. Immutable Artifact Format

Each benchmark run emits immutable telemetry containing:
- `dataSourceMode`: `'simulated' | 'empirical'`
- `priceTableVersion`, `model`, `scenarioId`, `arm`
- `rawCalls[]`: per-step raw `usage`, `latencyMs`, `overheadMs`, `gateDecision`, `assertionsPassed`
- Timestamp, Git Commit Hash, and environment metadata.
