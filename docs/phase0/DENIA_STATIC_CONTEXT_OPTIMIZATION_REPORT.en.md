[English](DENIA_STATIC_CONTEXT_OPTIMIZATION_REPORT.en.md) | [简体中文](DENIA_STATIC_CONTEXT_OPTIMIZATION_REPORT.md)

# Author Agent Static Context Optimization Phase 0 Report

**Project:** Author Agent / SurfCore / Bridge
**Phase:** Phase 0 (Read-only source audit, live trace verification, minimal Phase 1 rollout design)
**Generated:** `2026-11-12T00:10:00Z`

---

## 1. Executive Summary

Based on read-only verification of `src/bridge.js`, telemetry JSONL logs, and `.v4.jsonl.zstd` session files:

1. **Confirmed #1 Structural Redundancy Source:**
   - Across `91` wakes in `private:1587592535`, each wake appended `~16,011` chars (`~9,500` tokens) as a new `user/message`.
   - `12` session-static Layer B blocks (`8,416` chars, `~4,950` tokens, `52.6%` of the wake message) repeated identically `91` times, generating repeated Step-1 `cacheMiss` charges (`¥2.00/M`) and recurring `cacheHit` charges on every subsequent tool step while accelerating DSH Compaction.
2. **Corrected 6 "False-Static" Misclassifications:**
   - `stickerLine` (`1,127` chars avg, 6 lengths), `styleLine` (4 lengths), `hygieneLine` (2 lengths), `memoryCardLine` (22 lengths), `memoryBookLine` (9 lengths), and `memoryLine`/`memoryStatus` (12 lengths with live timestamps/interaction counters) change dynamically per turn and **must stay in dynamic Layer C**.
   - `roleLine` (DM `4,692` vs Group `5,076`) and `adminLine` depend on scene/config and therefore belong in session-level Layer B anchored by full-text SHA-256 fingerprint (`[SESSION_STATIC_CONTEXT]`), not hardcoded global YAML.
3. **First Trace Evidence of `94,979`-Token Compaction Cache Bust:**
   - In Turn 95, Step 1 hit `224,797` tokens and triggered `compaction/start` -> `compaction/summary` -> `compaction/end`.
   - On Step 2 immediately afterward, only `system/message + tools[]` (`39,296` tokens) stayed cached, while `<compacted-summary>` and retained history caused a single-step **`94,979` `cacheMiss` spike**!

---

## 2. Three-Layer Classification (A / B / C)

- **Layer A (`system/message + tools[]`, `39,296` tokens):** Preset instructions & MCP schemas. Untouched in Phase 1.
- **Layer B (`[SESSION_STATIC_CONTEXT]`, DM `8,416` chars / `~4,950` tokens):** 14 static/session-anchored blocks. Injected full on Turn 1, Compaction, hash change, or every 25 turns; otherwise replaced by a `118`-char anchor handle.
- **Layer C (Per-turn dynamic context, `~7,595` chars avg):** Timestamp, live snapshots, dynamic memory recall, conversational cues. Preserved 100% every turn.

---

## 3. KV Cache & Recovery Mechanism

- Eliminating `8,416` chars per turn drops Step-1 `cacheMiss` by `~4,830` tokens (`~53%`) and halves history growth rate, extending compaction intervals from `18–22` turns to `34–40` turns (~46% fewer compaction spikes).
- Commits `st.staticContextState` only after upstream delivery succeeds; clears `staticContextState` on `compaction/start|summary|end` events; provides 15-second non-destructive toggle rollback via `config.json`.
