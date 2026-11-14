[English](KV_CACHE_VALIDATION.en.md) | [简体中文](KV_CACHE_VALIDATION.md)

# Author Agent KV Cache Validation & Cost Boundary Correction (`KV_CACHE_VALIDATION`)

## 1. Three Empirical Corrections from Live Traces

Using live telemetry (`context-telemetry-bridge.jsonl`) and raw session traces (`session-5d062d1c...v4.jsonl.zstd`):

### 1.1 Correction 1: What Does Prepending Current Time to `user/message` Break vs. Preserve?
- Because messages `[0] .. [k-1]` in history already contain their past timestamps frozen in storage, adding current time at byte `0` of new message `[k]` **does NOT break historical KV Cache (`[0] .. [k-1]`)**:
  - DM Turn 95 Step 1: `cacheHit = 214,656` / `224,276` (**`95.71%`**)
  - Group Turn 38 Step 1: `cacheHit = 115,584` / `122,754` (**`94.16%`**)
- Instead, the true waste is injecting `8,416` chars (`~4,950` tokens) of Layer-B static text inside new message `[k]` every turn, triggering `10x` expensive `cacheMiss` in Step 1 plus compound `cacheHit` billing across every subsequent step.

### 1.2 Correction 2: Dissecting the `141,994`-Token Average Input Window
| Component | Token Scale | Share of `224,276` Peak | Share of `134,403` Post-Compaction Baseline |
|---|---:|---:|---:|
| 1. `system/message` + MCP `tools[]` | `39,296` | `17.5%` | `29.2%` |
| 2. `<compacted-summary>` | `~12,000–18,000` | `~6.7%` | `~11.2%` |
| 3. Accumulated Layer-B Static Blocks | `~80,000–115,000` | `~45.0%` | `~36.0%` |
| 4. Dynamic Layer-C + Tool Loops | `~65,000–85,000` | `~30.8%` | `~23.6%` |

- Deduplicating Layer-B halves history expansion (`~9,500` -> `~4,550` tokens/turn), reducing `~95k` compaction misses by `45%–50%` and shrinking baseline `cacheHit` volume by `35%–45%`.

### 1.3 Correction 3: Turn 95 36-Step Compaction Cache-Bust Trace
| Step | Event | `cacheHit` | `cacheMiss` | `output` | `totalTokens` | Cache Rate |
|---:|---|---:|---:|---:|---:|---:|
| **Step 1** | Wake request (`17,042` chars) | `214,656` | **`9,620`** | `521` | `224,797` | `95.71%` |
| *(Compaction)* | DSH `compaction/start -> summary -> end` shrinks `224.8k -> 134.4k` | *(off-ledger)* | — | — | — | — |
| **Step 2** | Post-compaction: only `system + tools` cached; summary + history miss | `39,296` | **`94,979`** | `128` | `134,403` | **`29.27%`** |
| **Step 3** | Summary cached; hit rate recovers | `134,400` | `215` | `331` | `134,946` | `99.84%` |
| **Step 4..36** | Remaining tool & reply steps | `134,784 -> 152,320` | `143~2,037` | `128~1,658` | `135,160 -> 152,602` | `98.6%~99.9%` |

- **Takeaway:** A single compaction bust (`94,979` `cacheMiss` tokens = `¥0.19` + `~¥0.06–0.10` summary cost = `¥0.25–0.30` per compaction) equals roughly `400` normal tool steps of cache misses.
