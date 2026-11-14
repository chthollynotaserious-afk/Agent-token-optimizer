[English](DIFFERENTIATION.md) | [简体中文](DIFFERENTIATION.zh-CN.md)

# Differentiation & Integration Strategy

- **Positioning:** **Universal Agent Optimizer** — *An open-source optimization middleware for long-running AI agents.*
- **Core Principle:** Optimize for **net API cost reduction (`Net Savings`) + zero quality regression + deterministic context governance**, rather than raw character compression ratio.

---

## 1. Four Technical Pillars of Differentiation

### A. Agent Context Lifecycle Management
Most compressors focus on shrinking a single payload before dispatch. In long-running agents, real economic collapse comes from **unbounded history growth and passive framework compaction breaking KV caches** (as observed in `KV_CACHE_VALIDATION`, where a single compaction event triggered `94,979` `cacheMiss` tokens on the very next step).

Instead of expensive mid-conversation compaction, UAO replaces compaction avalanches with **7-step transactional session rotation**:
1. **Acquire turn lock** to freeze concurrent writes during rotation.
2. **Await async memory flush** (`await onBeforeRotate(...)`) to persist facts, open tasks, and state.
3. **Verify persistence** via return receipt / sequence advancement.
4. **Build structured handoff envelope** (clean recent tail + on-demand lookup instructions).
5. **Activate next session** while keeping static System Prompt & Tool Schema prefix intact across sessions.
6. **Verify context recovery** before discarding prior pointers.
7. **Transactional rollback** on any failure in steps 2–6: restore old `sessionId`, `staticContextState`, and turn counter cleanly and emit an audit entry.

### B. Autonomous Invocation Optimization
Compressors cannot prevent unnecessary LLM calls from being made in the first place. Long-running agents running heartbeats, polling loops, or background event watchers often waste **50%+ of wakes on zero-output checks**, frequently after KV cache TTL expiration.

UAO's **Invocation Controller** operates *before* any model request:
- **Wake Coalesce / Dedup:** Collapses duplicate triggers within a configurable time window.
- **Zero-Cost Local Rules & Exponential Cooldown:** Filters low-value idle wakes locally with silent-streak backoff.
- **Guaranteed Priority Bypass Channel:** `URGENT / USER_DIRECT` events (direct user messages, mentions, blocking failures, explicit deadlines) are **never suppressed** by cooldown or low-priority quotas.
- **Budget-Aware Throttling:** Suspends background polls when low-priority budget hits threshold while preserving urgent handling.

### C. Cache-Aware Cost Optimization
**Fewer tokens != lower cost.** Altering bytes inside an active prefix invalidates downstream KV cache entries billed at `10x–50x` higher miss rates.

Core formula:
$$\text{Net Savings} = \text{Baseline Cost} - (\text{Optimized API Cost} + \text{Optimizer Overhead} + \text{Cache Rebuild Penalty})$$

Rules:
1. **Strict `observed` vs. `estimated` separation:** Only provider-reported `cached_tokens` / `cache_read_input_tokens` / `cache_creation_input_tokens` mark `observed`; offline heuristics always carry `estimated`.
2. **Provider-specific cache semantics:**
   - **DeepSeek / OpenAI:** Automatic prefix matching; protects system prefix and `tools[]` byte alignment.
   - **Anthropic Claude:** Explicit `cache_control` breakpoints and `cache_write` surcharges.
   - **Google Gemini:** Explicit Context Cache vs. implicit caching.
   - **Local LLMs (vLLM / llama.cpp):** Zero API cost, focused on KV reuse and TTFT latency.

### D. State-Aware Context Governance
The universal core must never require companion personas, emotion curves, or private memory schemas—yet multi-tenant and stateful agents need strict boundaries:
- **Mandatory Universal Core:** Fail-Closed multi-tenant / multi-scope ACL (`canAccessScope`), pinned slots, versioning, and secret redaction.
- **Optional `StateProvider` Plugins:**
  - `NoopStateProvider` (default, zero overhead for coding/stateless agents).
  - `CompanionStateProvider` (optional reference wrapper for companion emotion/reconsolidation).

---

## 2. Build vs. Integrate Boundary

| Capability | Decision | Integration Target | Rationale |
|---|---|---|---|
| **Multi-provider routing / Key pools / Org billing** | **Do not re-implement** | **LiteLLM** | Gateways already handle 100+ providers and org spend limits. |
| **JSON / Code / CLI general payload compression** | **Do not re-implement** | **Headroom** / **RTK** | `SmartCrusher` and `RTK` specialize in payload pruning; integrate via `Plugin` + Circuit Breaker. |
| **Neural token-level pruning** | **Do not re-implement** | **LLMLingua-2** | Heavy model inference belongs in optional offline/RAG sidecars. |
| **Full-text tool output indexing (FTS5/BM25)** | **Built-in lightweight + plugin** | **context-compress** | UAO ships zero-dependency `ToolResultRetentionStore`; optional `ContextCompressPlugin` bridges FTS5/BM25. |
| **Lossy compression safety gate** | **Adopt pattern** | **ContextPilot** | `Quality Gate + Cache Rebuild Cost Gate + Safe Fallback` implemented natively in `SingleCompressorCoordinator`. |

---

## 3. Open Core Viability Assessment

| Tier | Suggested Scope | Commercial Viability |
|---|---|---|
| **Community (MIT)** | Core optimization engine, standard adapters (OpenAI/Anthropic/MCP/LangGraph), local JSONL Ledger, CLI, Local Proxy, Python client | **Very High.** Must stay zero-lock-in and standalone to drive developer adoption. |
| **Developer** | Interactive cache/cost dashboards, cross-project regression diffing | **Medium.** Useful SaaS / desktop add-on without crippling CLI telemetry. |
| **Team** | Shared org budgets, policy templates, cache-busting alerts | **High.** Strong value for multi-agent engineering teams. |
| **Enterprise** | Clustered proxy deployment, SOC2 Fail-Closed ACL audit logs, custom SLA | **Highest.** Auditability and access control drive enterprise procurement. |
