[English](DENIA_P0_TOKEN_OPTIMIZATION_REPORT.en.md) | [简体中文](DENIA_P0_TOKEN_OPTIMIZATION_REPORT.md)

# Author Agent Token & Cost Phase 1 Audit Summary (`AUTHOR_AGENT_P0_TOKEN_OPTIMIZATION_REPORT`)

> **Scope:** Strictly read-only audit & proposal design (zero production edits, zero prompt/memory changes, zero restarts).

---

## 1. Spend Reconciliation (`Europe/London 2026-11-11`)

| Source / Window | API Calls | Turns / Wakes | Input Tokens | Cache Rate | Output Tokens | Cost (CNY) | Notes |
|---|---:|---:|---:|---:|---:|---:|---|
| Dashboard Snapshot | `1,597` | `257` / `178` | `226,764,805` | `96.8%` | `456,578` | `¥15.791` | Partial window + missing off-ledger calls |
| **Actual Paid Billing** | — | — | — | — | — | **`¥18.87`** | Authoritative calendar-day total |
| Cloud Ledger (`00:00–23:20Z`) | `1,629` | `252` / `180` | `234,597,523` | `96.46%` | `490,453` | `¥17.0191` | `token-usage.jsonl` + pricing rules |
| Off-Ledger Hidden Calls | `14` Compactions + `5` Titles + background wakes | — | `~1.85M` (compaction) | **`14.8%`** | `~44k` | `~¥1.76` + residual `~¥0.09` | Verified in DSH `.v4.jsonl.zstd` |
| **Reconciled Total** | `1,643+` | — | `~236.4M+` | `~95.8%` | `~534k+` | **`~¥18.87`** | Matches billing cleanly |

---

## 2. Key Diagnostic Findings (Q1–Q10 Summary)

1. **Who initiated the `1,629` calls?** Main DM (`850` calls / `¥8.40`), `16` group & friend chats (`713` calls / `¥7.76`), background corpus learner (`66` calls / `¥0.86`), plus off-ledger compaction & subprocess tasks.
2. **Why `8.60–8.97` calls per wake (`47–57` max)?** Zero network retries—`87.5%` (`1,350` calls) were serialized tool continuations (`489` sleep waits, `434` single-bubble sends, `95` close calls, `64` wake configs, `16` read marks) plus `66` zero-output turns (`¥3.080`).
3. **Why `96.46%` cache hit hid a `53.4%` cost leak:** `50x` miss-to-hit price spread (`¥1.00–2.00/M` vs `¥0.02–0.04/M`) meant `3.54%` misses caused `53.4%` of ledger spend, driven by compaction cache busts, idle wakes >30m, and MCP disconnects (`124 -> 63 -> 124` tools).
4. **What must NEVER be cut:** `memory-card` (`618` chars/wake) and `memory-book` (`264` chars/wake) represent `<0.2%` of total input and anchor long-term continuity across session rotations.
5. **Estimated non-overlapping savings (`¥18.87/day` -> `¥3.5–¥5.5/day`, ~70%–80% reduction):**
   - `Opt-1` (Session lifecycle rotation + cleaner compaction + stateless learner): `¥7.2–¥9.2/day`
   - `Opt-5` (Collapse protocol control roundtrips + batch sends): `¥1.8–¥2.5/day`
   - `Opt-2` (Dead tool removal + scene tool isolation): `¥1.6–¥2.2/day`
   - `Opt-4` (Lightweight proactive wake gating): `¥1.4–¥1.9/day`
   - `Opt-3` (Move static `base/role` out of per-turn history): `¥1.2–¥1.8/day`
   - `Opt-6` (Tiered `reasoningEffort` for routine turns): `¥0.8–¥1.1/day`
   - `Opt-7` (Tool output truncation + MCP reload stability): `¥0.5–¥0.8/day`
6. **Priority Calibration vs. Author Agent Self-Audit:** Adopted Author Agent's #1 priority (`Opt-1 + Opt-3 + Opt-2`), corrected the `recentCount: 100` misconception (already `wakeRecentLimit: 4`), and added zero-UX-loss `Opt-4 / Opt-5 / Opt-6` call-amplification savings.
