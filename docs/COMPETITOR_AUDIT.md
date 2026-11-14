[English](COMPETITOR_AUDIT.md) | [简体中文](COMPETITOR_AUDIT.zh-CN.md)

# Competitor Technical Audit

- **Audit Date:** `2026-11-14`
- **Objective:** Evaluate 5 core ecosystem/competitor projects (plus `rtk-ai/rtk` as CLI ecosystem reference) for architecture boundaries, license compatibility, and overlap with **Universal Agent Optimizer** (formerly `agent-token-optimizer (v1)`), preventing duplicated engineering and defining build-vs-integrate boundaries.
- **Evidence Tagging Convention:**
  - `[Verified Public Info]`: Derived from public GitHub repo metadata, official documentation, or public technical summaries.
  - `[Architectural Assessment]`: Engineering compatibility and differentiation analysis based on public architecture (never claimed as live benchmark results unless installed and run locally).

---

## 1. Landscape Overview Matrix

| Project | GitHub URL | License (as of `2026-11-14`) | Language / Form | Primary Focus | Overlap with UAO |
|---|---|---|---|---|---|
| **Headroom** | https://github.com/headroomlabs-ai/headroom | Apache-2.0 `[Verified Public Info]` | Python / Rust / TS (Proxy + SDK + MCP) | Context compression, type-aware pruning & Compress-Cache-Retrieve (CCR) | **High** (tool/history compression, Prefix Cache safety) |
| **ContextPilot** | https://github.com/msousa202/ContextPilot | MIT `[Verified Public Info]` | Python (SDK Middleware + Proxy + MCP + CLI) | Quality-gated & cache-aware local request compression | **High** (dedup, Prompt Cache awareness, Cost-aware fallback) |
| **context-compress** | https://github.com/Open330/context-compress | License not indexed publicly (verify `LICENSE` on clone) `[Verified Public Info]` | TypeScript (MCP Server + Hooks) | Coding-agent tool output filtering & SQLite FTS5/BM25 retrieval | **Medium** (tool result lifecycle, on-demand search vs full injection) |
| **LLMLingua** | https://github.com/microsoft/LLMLingua | MIT `[Verified Public Info]` | Python (PyTorch / Transformers) | Small-LM / encoder token-level prompt compression | **Low–Medium** (text compression kernel only; no agent lifecycle/gates) |
| **LiteLLM** | https://github.com/BerriAI/litellm | Core MIT; `litellm/enterprise` commercial `[Verified Public Info]` | Python (OpenAI-compatible Proxy + SDK) | Multi-provider LLM gateway, routing, budgets, SpendLogs | **Medium** (routing, key pools & billing belong in gateway layer) |
| *(Reference)* **RTK** | https://github.com/rtk-ai/rtk | CLI/filters Apache-2.0; `rtk-engine`/`rtk-proxy` BUSL-1.1 `[Verified Public Info]` | Rust (CLI Proxy) | Terminal coding command output compression (`git`/`pytest`) | **Low–Medium** (CLI output layer; note BUSL-1.1 hosting limits) |

---

## 2. Deep-Dive Audit

### 1. Headroom (`headroomlabs-ai/headroom`, Apache-2.0)
- **Mechanisms (`[Verified Public Info]`):**
  - Multi-mode access: FastAPI Proxy (`OPENAI_BASE_URL` / `ANTHROPIC_BASE_URL`), `headroom-ai` SDK, `headroom wrap`, and MCP Server (`headroom_compress`, `headroom_retrieve`, `headroom_stats`).
  - Type-aware compression (`ContentRouter`): `SmartCrusher` for large JSON arrays, `CodeCompressor`/`DiffCompressor`, `LogCompressor`/`SearchCompressor`.
  - **Live-Zone vs. Frozen Prefix:** Freezes early system/history prefix for KV cache while compressing high-churn tail content.
  - **CCR (Compress-Cache-Retrieve):** Stores raw payloads locally and allows models to fetch exact originals via hash breadcrumbs.
  - Supports LiteLLM Guardrail / Sidecar integration.
- **Boundary for UAO (`[Architectural Assessment]`):**
  - Headroom solves payload-level compression and CCR recovery very well, so **we must not re-implement `SmartCrusher`**. Integrate it via `HeadroomPlugin`.
  - Headroom does **not** manage pre-request idle wakeups (`InvocationController`), transactional cross-session rotation (`SessionLifecycleController`), or fail-closed multi-tenant tool/memory isolation.

### 2. ContextPilot (`msousa202/ContextPilot`, MIT)
- **Mechanisms (`[Verified Public Info]`):**
  - 4-stage pipeline (`Analyze -> Compress -> Quality Gate -> Forward`) scoring staleness, redundancy, relevance, and density.
  - **Quality Gate (`minQualityScore`, default `72/100`) + Safe Fallback:** automatically passes original payloads when compression degrades quality.
  - **Cost-aware Optimization:** explicitly models `0.1x` prefix cache discounts and aborts compression if predicted net savings are negative.
  - Privacy-first telemetry (numeric metadata only).
- **Boundary for UAO (`[Architectural Assessment]`):**
  - Its Quality Gate + Net-Cost Fallback pattern is adopted directly inside UAO's `SingleCompressorCoordinator` (`src/plugins/compression.js`) and `evaluateOptimizationEconomics()` (`src/core/cache-economics.js`).
  - Like Headroom, it operates per-request and does not manage multi-turn session lifecycle or autonomous wakeup throttling.

### 3. context-compress (`Open330/context-compress`)
- **Mechanisms (`[Verified Public Info]`):**
  - TypeScript MCP Server + hooks built for Claude Code / Codex workflows.
  - Intercepts oversized shell/test/file outputs before context rot, storing raw payloads in SQLite FTS5/BM25 for on-demand retrieval.
- **Boundary for UAO (`[Architectural Assessment]`):**
  - Validates the lifecycle `Raw Tool Output -> Local Retention Store -> Compact Handle -> On-Demand Retrieval` (`src/core/tool-output-retention.js`).
  - Pending `LICENSE` verification before bundling directly; exposed cleanly via `ContextCompressPlugin` (`src/plugins/external-optimizer.js`).

### 4. LLMLingua (`microsoft/LLMLingua`, MIT)
- **Mechanisms (`[Verified Public Info]`):**
  - v1 (`LLaMA-2-7B` entropy pruning, `~16.6–26.5 GB VRAM`) vs v2 (distilled `XLM-RoBERTa-large`/`mBERT` token classifier, `~2.1 GB VRAM`, `3x–6x` faster).
- **Boundary for UAO (`[Architectural Assessment]`):**
  - Token-level neural pruning can break KV cache byte alignment and corrupt strict JSON/code syntax, so it should **not** run in the default hot path; treat only as an optional heavy Python sidecar for one-off RAG pre-processing.

### 5. LiteLLM (`BerriAI/litellm`, MIT core)
- **Mechanisms (`[Verified Public Info]`):**
  - Multi-provider OpenAI-compatible gateway for 100+ providers, SpendLogs, Virtual Key/Team/Global budgets, RPM/TPM limits, and Failover.
- **Boundary for UAO (`[Architectural Assessment]`):**
  - Provider routing, key pools, and org billing belong in LiteLLM; UAO focuses on what gateways lack: **agent lifecycle rotation, wakeup suppression before API calls, scene-isolated tool schemas, and cache-rebuild net economics**.

### 6. Ecosystem Reference: RTK (`rtk-ai/rtk`, CLI Apache-2.0 / Engine BUSL-1.1)
- Local Rust CLI proxy for terminal command filtering (`git`, `pytest`, `docker`).
- Integrated purely via optional `RTKPlugin` CLI hook—no BUSL-1.1 code is bundled in UAO's MIT core.

---

## 3. Positioning & Niche Summary

```text
[Agent Runtime (Claude Code / LangGraph / AutoGen / OpenClaw / Custom)]
        │
        ▼
┌──────────────────────────────────────────────────────────────────────┐
│  Universal Agent Optimizer (Runtime Lifecycle & Cache Economics)     │
│  1. Autonomous Invocation Controller (Opt-4: Pre-request wake gate)  │
│  2. Session Lifecycle Engine (Opt-1: Transactional rotation + flush) │
│  3. Static/Dynamic Dedup & Cache Economics (Opt-3: Prefix net ROI)   │
│  4. Contextual Tool Governance & Loop Guard (Opt-2 + Opt-5)          │
│  5. Optional StateProvider + Fail-Closed Scope ACL                   │
└───────┬──────────────────────────────────────────────┬───────────────┘
        │ (Payload / Tool Output Compression Plugins)  │ (Provider Gateway)
        ▼                                              ▼
  [Headroom / context-compress / RTK]            [LiteLLM / Direct APIs]
```
