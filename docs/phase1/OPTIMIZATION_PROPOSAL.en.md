[English](OPTIMIZATION_PROPOSAL.en.md) | [简体中文](OPTIMIZATION_PROPOSAL.md)

# OPTIMIZATION_PROPOSAL — Prioritized Cost-Reduction Plan & Regression Controls

> **Strict Guardrails:** Zero degradation to the author agent's core persona, Memory Card/Book, emotion model, social abilities, allowlists, approval rules, or sandbox boundaries.
> **Baseline:** Reconciled daily spend `¥18.87/day` (`Europe/London 2026-11-11`); savings below are non-overlapping incremental estimates.

---

## 1. Prioritized Optimization Matrix

| Priority | ID | Optimization | Target Issue | Est. Daily Savings | Token Reduction | Regression Risk & Mitigation |
|---|---|---|---|---:|---:|---|
| **P0** | **Opt-1** | **Session Lifecycle Rotation + Tighter Compaction Floor**<br/>Rotate chats at `maxTurns: 20–30` or `>4h` idle into clean sessions preserving Memory Card + Memory Book + ~800-char handoff; lower `thresholdRatio` `0.22 -> 0.10` & `retainRatio` `0.06 -> 0.025`; reset stateless learner batches. | `144K` bloated baseline + `14` hidden compaction cache busts | **`¥7.2 – ¥9.2 / day`** | `~105M – 130M` input/day | **Risk:** forgetting trivial turns >30 turns back.<br/>**Mitigation:** high-density handoff summary + guaranteed Memory Card/Book recall. |
| **P0** | **Opt-2** | **Remove Dead Tools (`onebot-min`) + Scene Preset Tool Isolation**<br/>Drop 19 blocked `onebot-min` tools (`6,827` chars); isolate group/background presets (`~124` tools/`26.7k` tokens -> DM `~55`/`12k`, Group `~25`/`5k`). | Turn-1 `~26.7k` schema bloat + MCP reload cache breaks + blocked-tool retries | **`¥1.6 – ¥2.2 / day`** | `~22M – 32M` input/day | **Risk:** hiding needed tools in group chats.<br/>**Mitigation:** validate against 7-day `tool-calls.jsonl` actual usage; keep full suite in private DM. |
| **P0** | **Opt-3** | **Move Static `base/role` out of Per-Turn `user/message` History**<br/>Move ~`10KB` static rules/persona blocks to System Prefix or Turn-1/on-change injection; keep timestamps/volatile counters at tail without touching `recentCount`. | `13.5k–16.5k` char/turn history snowball | **`¥1.2 – ¥1.8 / day`** | `~18M – 25M` input/day | **Risk:** long-session instruction drift.<br/>**Mitigation:** paired with Opt-1 20–30 turn rotation & System Prefix anchoring. |
| **P1** | **Opt-4** | **Lightweight Pre-Gate for `proactiveCheck`**<br/>Evaluate `proactive-policy.js` / energy / activity locally before waking stale `100k+` cache sessions; always bypass for direct @mentions/replies/DMs. | Cold-cache zero-output proactive wakes (`54%` no-op) | **`¥1.4 – ¥1.9 / day`** | `~1.5M` high-cost misses + `~10M` hits | **Risk:** slightly fewer unprompted cold pings.<br/>**Mitigation:** 100% immediate wake for `mustReply` urgent events. |
| **P1** | **Opt-5** | **Collapse Protocol Control Steps & Batch Multi-Bubble Sends**<br/>Allow array batching in send tool, fold `mark_read`/`close`/`set_wake` tail params, and replace mandatory `300s` LLM sleep calls with bridge wake debounce. | `87.5%` tool continuation share (`489` wait calls) | **`¥1.8 – ¥2.5 / day`** | `~35M – 50M` continuation tokens (`300–450` fewer calls) | **Risk:** fast burst feel or missing quick follow-ups.<br/>**Mitigation:** async spaced delivery at bridge layer + short ingress debounce. |
| **P1** | **Opt-6** | **Tiered `reasoningEffort` (`max` -> `low`/`medium` for routine steps)**<br/>Lower thinking budget on routine chat/sleep steps (where `58%` of output chars were hidden reasoning at `¥4–¥8/M`), preserving `medium/high` for complex reasoning & commands. | Hidden reasoning output costs (`96%` non-user-facing output) | **`¥0.8 – ¥1.1 / day`** | `~180k – 250k` reasoning output/day | **Risk:** weaker pronoun resolution in multi-user groups.<br/>**Mitigation:** staged rollout starting from stateless learner & simple chat. |
| **P2** | **Opt-7** | **Tool Result Truncation Caps & MCP Stability**<br/>Bound large read/search tool outputs pre-history with summary + `offset/limit` hints, and stabilize MCP connections to prevent schema list drops. | Single-step cache pollution & `developer/message` resets | **`¥0.5 – ¥0.8 / day`** | Reduced `cacheMiss` spikes | **Risk:** extra paginated read on large files.<br/>**Mitigation:** head/tail preview + exact line counts + `startLine/endLine` retrieval. |

---

## 2. Combined Target Outcome (Non-Overlapping Rollout)

- **Stage 1 (`Opt-1 + Opt-2 + Opt-3`):** Average input drops from `144K` to `~45K–65K` tokens; daily hidden compactions drop from `14/day` to `0–2/day`; daily spend falls from `¥18.87` to `~¥7.5–¥9.5/day` (**50%–60% savings**).
- **Stage 2 (`+ Opt-4 + Opt-5 + Opt-6 + Opt-7`):** Calls per wake drop from `8.6–8.97` to `~2.5–4.0`; projected total daily spend **`~¥3.5–¥5.5/day` (~70%–80% cumulative reduction)** with zero loss of persona or memory continuity.
