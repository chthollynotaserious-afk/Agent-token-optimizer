[English](CONTEXT_ASSEMBLY_MAP.en.md) | [简体中文](CONTEXT_ASSEMBLY_MAP.md)

# Author Agent Context Assembly Pipeline & Request Mapping (`CONTEXT_ASSEMBLY_MAP`)

## 1. Deployment Baseline & File Fingerprints (Read-Only Snapshot)

- **Audit Time:** `2026-11-12T00:03:00Z` (`Europe/London`)
- **Host Process Baseline:** Non-git production directory (`package.json` version `0.8.8`) anchored by file SHA-256 hashes:

| File | SHA-256 | Notes |
|---|---|---|
| `src/bridge.js` | `5effa20ff102cafec0e1c30a72b0651b3abb61f7ef71c35a2791733abd31d333` | `22,718` lines, main bridge process |
| `config.json` | `3006c362676d106e2bad29493bdf477eeeab82200cb8a673a319b4cb8c4cca45` | Runtime configuration |
| `dsh/agent-presets/qq-chat-v2/agent.cordis.yml` | `3f20f1a2c86ed550997f14732ae5a1b898f4906d54f2a9ca554048fc79299cb0` | Preset & `compaction` parameters |
| `plugins/surfcore/qq-tool-restrict.mjs` | `1e863ab66a0f3057c0091af092e40887e97e8dd5d4bfed941628359d1d53d505` | `agent/Instruction` & `agent/Tool` restriction plugin |

---

## 2. Full 7-Step Context Assembly Pipeline

1. `sendWakePromptV2(key, reason, wakeOpts)` (`src/bridge.js:18575`)
2. `buildWakePromptV2(key, opts.wakeReason)` (`src/bridge.js:18295-18562`) concatenates 40 variables into `base` plus reason-specific suffix.
3. `deliverPromptNow(key, promptText, opts)` (`src/bridge.js:16236-16326`) appends message snapshot & folded notice and writes `contextTelemetry.wake`.
4. `withSlangContext(promptText)` (`src/bridge.js:4209-4218`) prepends current timestamp + slang block at offset `0`.
5. `withAlignmentContext(key, text)` (`src/bridge.js:4222-4225`) appends identity source alignment footer (`144` chars DM / `117` chars group).
6. `submitPromptWithCorrection -> api.sessions.prompt` appends the text as a new `role='user'` `user/message` into DSH session history.
7. DSH assembles final payload: `system/message + tools[] + history(user/assistant/tool) + current user/message`.

- **Key Observation:** `system/message` + `tools[]` consume `39,296` tokens (anchored by post-compaction `cacheHit: 39,296`) and remain fixed at `messages[0]`, whereas every `buildWakePromptV2` payload (`12.5k–17k` chars) was appended verbatim into mutable `user/message` history every single turn.

---

## 3. Observed Trace Comparisons (DM vs. Group)

- **DM Trace (`private:1587592535`, Turn 95, `w_1794440287561_3`):**
  - Pre-wrap `promptChars = 16,866` (`base = 14,728`, `snapshot = 1,622`); persisted `user/message = 17,042` chars (`55` sections documented in Chinese archive table).
  - Step 1 API usage: `cacheHit = 214,656`, `cacheMiss = 9,620`, `output = 521`, `totalTokens = 224,797`.
- **Group Trace (`group:588475979`, Turn 38, `w_1794440688264_4`):**
  - Pre-wrap `promptChars = 12,490`; persisted `user/message = 12,641` chars.
  - Step 1 API usage: `cacheHit = 115,584`, `cacheMiss = 7,170`, `output = 304`, `totalTokens = 123,058`.
- **Group Isolation Confirmed:** `memoryCardLine` restricts to `shared` slots (`503` chars vs DM `2,176`), while `memoryBookLine = 0` and private cross-session prompts are omitted.

---

## 4. Five Architectural Verification Conclusions (2.1-Q1 ~ 2.1-Q5)

| ID | Question | Verified Conclusion |
|---|---|---|
| **2.1-Q1** | Relationship between System Prompt and `buildWakePromptV2`? | Completely separated: `system/message` is created once at `api.sessions.create`; each `buildWakePromptV2` is appended as a brand new `user/message`. |
| **2.1-Q2** | Where are `withSlangContext` & `withAlignmentContext` applied? | At `deliverPromptNow` (`bridge.js:16329`), *after* `contextTelemetry.wake` logging and right before `api.sessions.prompt`, putting current timestamp at byte `0` of `user/message`. |
| **2.1-Q3** | Does static content from `buildWakePromptV2` remain in history across turns? | Confirmed 100%: every wake appended `12,672–19,059` chars (avg `16,011`) until DSH Compaction fired. |
| **2.1-Q4** | Does DSH Compaction strip Turn-1 injected static context? | Confirmed (`seq:7800–7806`): `<compacted-summary>` replaces early `user/message` turns, so `sessionStaticHash` must reset on `compaction/end`. |
| **2.1-Q5** | Will single Turn-1 injection decay over 90+ turns? | Yes—both via Compaction stripping and attention dilution across `100k+` tokens; mitigated by post-compaction re-injection and periodic refresh every `N=25` turns. |

*(Full 55-section byte-offset breakdown table is preserved verbatim in [CONTEXT_ASSEMBLY_MAP.md](CONTEXT_ASSEMBLY_MAP.md).)*
