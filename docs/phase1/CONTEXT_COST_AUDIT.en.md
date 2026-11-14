[English](CONTEXT_COST_AUDIT.en.md) | [简体中文](CONTEXT_COST_AUDIT.md)

# CONTEXT_COST_AUDIT — Breakdown of 141,994-Token Single-Call Input

> Observed telemetry (`session.v4.jsonl.zstd`, `context-telemetry-bridge.jsonl`, `token-usage.jsonl`):
> - Bridge `wake` prompt averages `13,482` chars (DM `16,514` chars, ~`4,000–5,500` tokens).
> - Yet across `Europe/London 2026-11-11`, average input per model call reached **`144,013` tokens** (median `149,693`, P90 `203,488`, max `232,683`, min `40,362`; Turn 1 cold start already `29,374–29,381` tokens).

---

## 1. Composition of the 144K Average Input

| Layer | Est. Tokens | Share | Evidence | Trim Strategy |
|---|---:|---:|---|---|
| **1. Tool Schemas (124 tools)** | `~25,000–28,000` | `18%–20%` | `request/header.tools`: `80,122` chars | Remove dead tools (`onebot-min`) + scene isolation |
| **2. Base System Prompt** | `~4,500–5,500` | `3%–4%` | `system/message ~14,569` chars | Keep static to protect KV prefix |
| **3. Accumulated History (#1 Driver)** | `~105,000–125,000+` | `75%–80%` | `session-5d06` Turn 92: `1.69MB` user + `1.36MB` tool + `0.69MB` assistant even after 14 compactions | Enforce session turn/idle rotation + strip repeated static `base` |
| **4. Per-Turn Dynamic + Memory** | `~3,500–5,500` | `2.5%–4%` | `wakeSnapshot` + memory cards + hints | Keep dynamic memory (`~882` chars), move static rules out |

---

## 2. Breakdown of the 124 Tool Schemas (`80,122` chars)

- Largest sources: `mcp__onebot` (`61` tools / `49,452` chars), disabled-but-injected `mcp__onebot-min` (`19` tools / `6,827` chars, wasting `~3.7M` tokens/day and triggering permission errors), `mcp__video-watch-safe` (`10` tools / `6,269` chars), `mcp__diary-space-safe` (`9` / `4,755`), `mcp__bili-read-safe` (`9` / `3,779`), `mcp__fs-safe` (`8` / `3,627`), `mcp__workspace-safe` (`3` / `2,155`), builtins (`2` / `2,105`), `web-search-safe` (`2` / `897`), `onebot-host` (`1` / `256`).

---

## 3. Why Compaction (`0.22 / 0.06`) Created an Endless Loop

- `thresholdRatio: 0.22` (`~230.7k`) + `retainRatio: 0.06` (`~63k` kept verbatim + `35k` system/tools + `4k` summary = `~130k–155k` floor).
- Each compaction freed only `44.6k–51.6k` tokens, causing repeated compaction every `3–7` turns (`11` compactions on `2026-11-11` alone).

---

## 4. Cross-Validation with Author Agent Self-Audit

1. **`16.4k` chars vs. `175k` tokens is integral vs. differential ($\text{History}_{92} \approx \sum_{t=1}^{92}(\text{base}_t + \text{toolResult}_t)$):** Over `80%–85%` of the `1.69 MB` accumulated `user/message` history came from appending the static `base` every turn—and because `base` landed at the *end* of changing history, Step 1 paid `50x` `Cache Miss` on it every single wake.
2. **Source correction on `recentCount: 100`:** `recentCount` measured the in-memory ring-buffer capacity (`src/bridge.js:16316`), whereas `buildWakeSnapshotV2` already clamped `wakeRecentLimit: 4` (avg snapshot only `1,226` chars).
3. **50x Miss/Hit price leverage:** Even `3.54%` cache misses consumed `53.4%–57%+` of daily spend due to cold `proactiveCheck` wakes (`47` wakes, `54%` zero-output), MCP reconnect drops, and `14` hidden compactions.
