[English](ARCHITECTURE_GAP_ANALYSIS.md) | [简体中文](ARCHITECTURE_GAP_ANALYSIS.zh-CN.md)

# Architecture Gap Analysis (Baseline vs. Target Middleware)

- **Audit Target:** `agent-token-optimizer (v1)` (baseline commit `main @ c0665e3`)
- **Audit Method:** Line-by-line inspection of `src/` (17 legacy modules), `scripts/`, `docs/phase0`, and `docs/phase1`, paired with live execution of the baseline test scripts. **Claims in `README.md` are never accepted without runtime verification.**

---

## 1. Baseline Findings (Source vs. Legacy README Verification)

After running the legacy test command (`node --test scripts/test-context-selector.mjs scripts/test_cost_calc.mjs scripts/test-emotion-memory-v2.mjs scripts/test-session-rotation.mjs`) and auditing `src/`:

1. **Fatal Missing Dependency (`src/model-prices.js` absent in baseline):**
   - `src/token-ledger.js:38` and `src/tool-cost-attribution.js:19` both imported `./model-prices.js`, which did not exist in the baseline `src/` tree. Any external caller importing either file immediately hit `ERR_MODULE_NOT_FOUND`.
2. **False-Green Test (`scripts/test_cost_calc.mjs`):**
   - Hardcoded host path `/srv/agent/data/state/context-telemetry-bridge.jsonl` and silently exited with code `0` (`file not found`) outside the production host (lines 4–7), causing `npm test` to report green without executing `token-ledger.js` or `tool-cost-attribution.js`.
3. **Large Test Coverage Blind Spots:**
   - Out of 17 files in baseline `src/`, only 4 (`context-selector.js`, `emotion-state.js`, `memory-reconsolidation.js`, `session-rotation.js`) had runnable standalone tests.
   - 11 modules (`static-context-dedup.js`, `prompt-fingerprint.js`, `proactive-gate.js`, `proactive-policy.js`, `proactive-config.js`, `token-budget.js`, `token-guard.js`, `turn-end-policy.js`, `turn-guard.js`, `priority-budget.js`, `v2-wait.js`) had no runnable standalone tests (referenced scripts depended on missing `./audit-bridge-harness.mjs` and `../src/owner-quote.js`).
4. **Opt-2 (Contextual Tool Governance) Lacked a Runtime Engine:**
   - `tool-cost-attribution.js` only performed post-hoc telemetry attribution, while actual Opt-2 cleanup was a one-off YAML patch script (`scripts/remote-opt2-remove-onebot-min.mjs`), not a reusable runtime `ToolGovernance` engine.
5. **Opt-1 (`session-rotation.js`) Had Async Flush Race & No Rollback:**
   - Invoked `opts.onBeforeRotate(...)` synchronously without `await` or error handling (lines 117–126) before immediately clearing `st.sessionTurns = 0`, `st.staticContextState = null`, and `delete state.sessions[key]` (lines 146–148). Any async flush or recovery failure corrupted session continuity without rollback.

---

## 2. Module-by-Module Audit Matrix

| Module | Legacy File | Implemented | Design-Only / Missing | Competitor Overlap | Standalone Value | Recommended Integration | Refactoring Required for Universal Core | Keep as Optional Author Agent Plugin |
|---|---|---|---|---|---|---|---|---|
| **Opt-1** | `src/session-rotation.js` (162 lines) | Turn/token/idle thresholds, sliding handoff builder, sync `onBeforeRotate`, `sessionHistory` | Async transactional rotation, persistence & recovery verification, rollback, domain-neutral handoff | Low (Headroom/ContextPilot lack session rotation state machines) | **Very High**: replaces expensive mid-session compaction avalanches with cheap rotation | `context-compress` / CCR for handoff detail lookup | Remove `private:`/`group:` & QQ prompt hardcoding; upgrade to 7-step transaction | QQ v2 simulation handoff template |
| **Opt-2** | `src/tool-cost-attribution.js` (147 lines) + `scripts/remote-opt2-...mjs` | Post-hoc step tool cost attribution, one-off YAML cleanup | **Runtime Tool Schema pruning, scene isolation & schema jitter detection** | Low–Medium (Headroom compresses tool *outputs*, not scene-level input schemas) | **High**: cuts 26k+ Turn-1 schema overhead & preserves prefix cache | Delegate verbose stdout compression to `Headroom` / `context-compress` | Add runtime `ToolGovernance` engine + fix `model-prices.js` | `onebot-min` patch script & QQ tool allowlists |
| **Opt-3** | `src/static-context-dedup.js` (153 lines) + `src/prompt-fingerprint.js` (82 lines) | Session `SHA-256` static block dedup, sub-block hash tracking, `memoryCard` ID dedup | Provider cache-mode profiles (`DeepSeek` vs `Anthropic cache_control` vs `Gemini`), net-cost rebuild gate | Medium (ContextPilot system dedup, Headroom Frozen Prefix) | **Very High**: zero-history-tampering + periodic refresh + incremental fingerprint | Pair with `ContextPilot`-style quality/cost gate | Generalize `stickerRaw`/`memberImpressionsRaw` into generic `subBlocks`; strip QQ regexes | QQ ID normalization rules in `prompt-fingerprint.js` |
| **Opt-4** | `src/proactive-gate.js` + `policy.js` + `config.js` | Suppression rules, `noReplyLocked`, exponential backoff, active-window & emotion bias | Domain-neutral `TriggerEvent`, wake coalesce/dedup, budget gating, urgent bypass | **Very Low** (competitors compress *after* wakeups, not before calling LLMs) | **Very High**: eliminates 50%+ zero-output idle wakeups | Pair with Cron / Webhook schedulers | Generalize `unread/pendingThoughts/activeTopics`; decouple `emotionBias` & `qq`/`group:` keys | QQ proactive probability curve & social silence rules |
| **Opt-5** | `src/turn-guard.js` + `turn-end-policy.js` + `v2-wait.js` | Step limit, streak error breaker, repeated arg loop detection, side-effect idempotency | Generic tool policy registry, lossless tool result retention + retrieval | Low (generic `max_steps` lacks expected-denial differentiation & idempotent recovery) | **High**: prevents runaway tool loops & duplicate side effects | `Headroom` / `context-compress` for large outputs | Externalize hardcoded QQ/Chinese regexes into injectable tool policies | `v2-wait.js` QQ fragment-waiting heuristic |
| **Ledger & Budget** | `src/token-ledger.js` + `token-budget.js` + `token-guard.js` + `priority-budget.js` | Idempotent event collapse, peak/off-peak pricing, 80%/100% dual budgets, P0/P1/P2 tiers | **Missing `model-prices.js`**, standard OpenAI/Anthropic/Gemini normalization, Net Savings economics | Medium–High (LiteLLM covers gateway SpendLogs & org budgets) | **Medium–High**: fine-grained `(turn, step, retry)` cache leverage accounting | Multi-tenant billing & routing via **LiteLLM** | Add multi-provider `model-prices.js`; strip DSH/`~/.dsh/surfcore` paths & `qq/bili` buckets | Fixed `qq/bili/other` buckets & `surfcoreDir` |
| **Context Selector** | `src/context-selector.js` (835 lines) | `sourceRef` provenance, Fail-Closed `visible()`, dedup, slot budgets, redaction | Domain-agnostic `ScopeACL`, pluggable `ContextSource` | Low–Medium (competitors rank by relevance, rarely enforce Fail-Closed ACL) | **High**: deterministic multi-tenant/channel isolation | Vector DB / FTS5 retrieval backends | Separate `visible()` into generic `ScopeACL`; inject sources rather than reading host paths | `biliMemoryPath`/`dreamKind`/`isBlood`/CN card formats |
| **Memory Reconsolidation** | `src/memory-reconsolidation.js` | 0.15 reconsolidation factor, sentiment tagging, 0.18 mood-congruent boost | Wrap behind optional `StateProvider` interface | Very Low | Low (companion agents only) | — | Remove hard import from core `context-selector.js` | **Keep entirely as optional companion plugin** |
| **Emotion State** | `src/emotion-state.js` | Emotion/need decay, energy model, veto cooldown | Wrap behind optional `StateProvider` interface | Very Low | Low (companion agents only) | — | Remove hard import from core `proactive-policy.js` | **Keep entirely as optional companion plugin** |

---

## 3. Four Architectural Gaps Identified & Resolved in v2

1. **Package integrity & testability gap** (`model-prices.js` missing, false-green `test_cost_calc.mjs`, untested modules).
2. **Domain coupling inside core algorithms** (`private:*` / `group:*`, `qq` / `bili` / `pet`, `~/.dsh/surfcore`, hardcoded Chinese strings).
3. **Missing unified middleware orchestrator & protocol adapters** (17 standalone helpers without `UniversalAgentOptimizer`, `AgentAdapter`, or `Proxy` mode).
4. **Missing quality gates & reproducible multi-scenario benchmarks** (previously only Author Agent production telemetry snapshots existed).
