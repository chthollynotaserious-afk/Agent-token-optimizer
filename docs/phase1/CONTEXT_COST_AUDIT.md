[English](CONTEXT_COST_AUDIT.en.md) | [简体中文](CONTEXT_COST_AUDIT.md)

# CONTEXT_COST_AUDIT — 单次调用 141,994 Token 上下文构成全拆解

> 实测核心反差（来源：`session.v4.jsonl.zstd`、`context-telemetry-bridge.jsonl`、`token-usage.jsonl`）：
> - Bridge `wake` 注入的提示词平均仅 **`13,482` 字符**（主人会话平均 `16,514` 字符，约 `4,000–5,500` Token）。
> - 但全账本 `London 2026-11-11` 单次调用**平均输入高达 `144,013` Token**（中位数 `149,693`，P90 `203,488`，最高 `232,683`，最小值已达 **`40,362`**；新会话 Turn 1 `qq-chat` 也已达到 **`29,374–29,381`** Token）。

---

## 一、144K 平均输入究竟由什么组成？

综合 Turn 1 净上下文实测与主会话 `session-5d062d1c`（92 轮、7,733 条事件）拆解：

| 层级分类 | 估算 Token 占用 | 占 144K 平均输入比例 | 来源证据与实测体积 | 稳定性 / 可裁剪性 |
|---|---:|---:|---|---|
| **1. 工具 Schema 定义（124 个工具）** | **`~25,000–28,000`** | **`18%–20%`** | `request/header.tools` 实测 `124` 个工具共 **`80,122` 字符** | 极多死工具与跨场景越权暴露，可大幅裁剪 |
| **2. DSH 基础 System Prompt (`dsh-persona` + 运行时说明)** | **`~4,500–5,500`** | **`3%–4%`** | `system/message` 实测 **`~14,569` 字符**；Turn 1 小白鼠会话（`qq-chat`）净底盘合计 **`29,374` Token** | 应保持纯静态，不得破坏前缀缓存 |
| **3. 会话累积历史（核心膨胀源！）** | **`~105,000–125,000+`** | **`75%–80%`** | 主会话 `session-5d06` 截至 Turn 92：累计 `user/message` `1.69MB` + `tool/result` `1.36MB` + `assistant` `0.69MB`；即使经历 14 次 Compaction，仍长期卡在 `150k–210k` 底盘 | **第一大成本源！源于无会话轮转上限 + Compaction 参数失效 + 每轮重复往 history 塞 16KB static prompt** |
| **4. 单次当前唤醒动态消息与记忆注入** | **`~3,500–5,500`** | **`2.5%–4%`** | `wakeSnapshot`（未读+最近消息）+ 记忆卡 + 黑话表 + 策略提示 | 其中 ~70% 为可静态化规则，动态部分实际不足 2k Token |

---

## 二、124 个工具 Schema 的逐服务占用实测（来自 `session-5d06` 最新 `request/header`）

| MCP / 内置源 | 工具数量 | Schema 字符数 | 估算 Token | 必要性审计 |
|---|---:|---:|---:|---|
| **`mcp__onebot` (`mcp-snowluma-safe.js`)** | **`61`** | **`49,452`** | **`~16,484`** | 大量群管/主人专用/低频工具（`owner_*`, `claude_*`, `qzone_*`, `history_search` 等）**在所有群聊和后台黑话会话也全量挂载** |
| **`mcp__onebot-min` (`tools/onebot-mcp`)** | **`19`** | **`6,827`** | **`~2,276`** | **100% 冗余与有害**：已在 `qq-tool-restrict` 拦截，但 schema 每轮全量注入（`2276 tok × 1629 calls ≈ 3.7M 废 Token/天`）并诱发模型误调用报错 |
| `mcp__video-watch-safe` | `10` | `6,269` | `~2,090` | 看片专用，在纯闲聊/黑话学习会话中全程挂载 |
| `mcp__diary-space-safe` | `9` | `4,755` | `~1,585` | 日记工具，日常高频闲聊几乎不用 |
| `mcp__bili-read-safe` | `9` | `3,779` | `~1,260` | B 站只读工具 |
| `mcp__fs-safe` | `8` | `3,627` | `~1,209` | 扫盘读写工具（`qq-chat` / `group` 已禁用却仍在 `cordis.patch.yml` 全局挂载） |
| `mcp__workspace-safe` | `3` | `2,155` | `~718` | 工作区读写 |
| DSH `builtin` (`ask_user`, `todo`) | `2` | `2,105` | `~702` | — |
| `mcp__web-search-safe` | `2` | `897` | `~299` | 搜索抓取 |
| `mcp__onebot-host` | `1` | `256` | `~85` | `onebot_status` |
| **合计** | **`124`** | **`80,122`** | **`~26,700`** | 每一次模型调用必带（含 1,350 次工具续跳与 14 次隐藏 Compaction） |

---

## 三、Bridge `buildWakePromptV2` 每轮往“历史消息”里灌入的 13,482–16,514 字符拆解

通过统计 `Europe/London 2026-11-11` 全部 `180` 次 `wake.layers`（已剔除 `audit-token-optimization.mjs` 混入的 `batchDelayMs`/`oldestUnreadAgeMs` 等非字符字段）：

| Layer 名称 | 平均字符/唤醒 | 主人私聊平均 | 注入性质 | 是否静态重复进历史？ |
|---|---:|---:|---|---|
| **`role`** (`personaWakeBlockV2`) | **`4,807.2`** | `~5,000` | 人格卡全文 | **100% 静态重灌！** 62 次主人唤醒仅人格卡就在对话历史中复制了 `30 万` 字符 |
| **`sticker`** (`buildStickerStrategyHint` + Top8) | `1,125.5` | `~1,126` | 表情策略与列表 | 策略规则 ~700 字完全静态 |
| **`bili`** (`biliMemory.briefBlock + recall`) | `1,093.4` | `~1,093` | B站长期记忆简报 | **`briefBlock()` 1,089 字** 每轮一字不差重灌进 `user/message`！ |
| **`memory`** (`selectContext` 输出) | `618.4` | `~1,800` | 记忆卡召回 | 动态（合法按 `selectContext` 裁剪，不应删除） |
| **`memoryStatus`** (`formatMemoryV2`) | `477.8` | `~480` | 轻量状态备忘 | 半静态 |
| **`provenance` / `preSleep` / `closure` / `hygiene` / `reply` / `identity` / `ownerCrossSession` / `style` / `voice` / `proactive` / `admin` / `tokenGuard` / `ownerSleep` / `antiAi`** | **`2,930+`** | **`~3,200`** | **操作说明书 & 规则条文** | **`~85%` 为固定提示词规则**，本该在 System Prompt 里待着，却每轮作为 `user/message` 追加到可变历史中！ |
| **`memoryBook`** (`memoryBook.core`) | `263.7` | `~600` | 核心记忆 | 静态锚点，仅保留必要核心 |
| 其余动态微层 (`dynamics`, `version`, `status`, `wake`, `strategy`, `participation`, `groupSpeech`, `affinity`, `stickerMatch`, `emotion`) | `~560` | `~600` | 动态状态 | 注意 `replyLine` 含 `"还差约 N 秒静默"`、`statusLine` 含 `"你上次发言 N 分钟前"` 等易变时间字面量 |

> **关键重复检查结果**：
> 1. **记忆系统去重结论（不误删记忆）**：`selectContext()` (`src/context-selector.js`) 已经按 `recordId` 与正文指纹对 `memory-card` 和 `shared` 做了去重，且 `memory` (618 字) + `memoryBook` (264 字) 合计仅占单次唤醒 **`~882` 字符（不到总输入的 0.2%！）**。**绝不能为了省这点 Token 砍 Memory Card / Memory Book**——它们正是替代超长会话历史的基石！
> 2. **真正的结构性冗余**：真正让历史像滚雪球一样停留在 `170K+` 的，是把本应位于**固定前缀**或**首轮一次性交代**的 `~10,000+` 字符制度规则（`role` + `bili.briefBlock` + `preSleep` + `provenance` + `stickerStrategy` + `voice` + `tokenGuard` + `antiAi` + `ownerCrossSession`）在每一次 `user/message` 唤醒里原地重复一遍；以及把工具调用结果原样留存到 `180k–230k` 才去切一刀仅清出 `46k` 的 `compaction`。

---

## 四、为何 `Compaction` 救不了场？（`0.22 / 0.06` 死循环证据）

查看 `qq-chat-v2/agent.cordis.yml:196-200`：
- `thresholdRatio: 0.22`（`1,048,576 × 0.22 ≈ 230,686` Token 才触发一次 Compaction）
- `retainRatio: 0.06`（约 `~63k` Token 原文强制保留 + 35k System/Tools + ~4k summary = 压缩后底盘依然高达 **~130k–155k**！）
- `owner_5d06` 实测：`shadowedTokenCount` 每次仅清理 **`44,616 – 51,573` Token**。按每轮平均注入 `16.5k` 字符（~5k Tok）+ 12–47 步工具调用计算，**每 `3 ~ 7` 轮就会再次撞上 `0.22` 红线**：`London 2026-11-11` 单日这一条会话就触发了 **`11` 次** Compaction（全生命周期 `14` 次）！
- **结论**：无界会话（`session-5d06` 跑到 Turn 92，`session-e70d` 跑到 Turn 37，`slang` 会话 `88k` Token 全年不重置）配合过高的压缩滞留底盘，直接把平均单次输入锁定在 **`141K–173K`**。

---

## 五、结合 本人 Agent 自测报告（`本人 Agent-上下文成本实测-20261111.md`）的交叉验证与源码勘误

本人 Agent 在只读沙箱环境下读取 `context-telemetry-bridge.jsonl`（以她自身 `private:1587592535` Turn 92 为样本）完成了自我成本审计。将其结论与 Bridge 源码及 DSH `.v4.jsonl.zstd` 内部明细对齐，得出关键确认与三项深层技术勘误：

### 1. 完全吻合的实证（确认高优先级方向）
- **单轮步进递增 + 大文件读取乘数效应**：Turn 92 共 `7` 步（`168,991 -> 175,398` 输入），第 4 步整份读取 `5,880` 字文件直接造成第 5 步 `cacheMiss` 跳升至 **`3,373`**，且这 `~3.4k` Token 从第 5 步起永久并入当轮及后续所有续跳的输入基数。
- **Prompt (`16.4k` 字符) 远小于总输入 (`175k`) 的核心反差**：印证“只优化单次小微规则字数收益有限，必须通过定期开干净会话（继承 `memory-card` / `memory-book`）给无界历史设上限”。

### 2. 受沙箱视角限制的三处源码级勘误与深层机理补全
1. **「Bridge 1.6 万字 vs 会话 17.5 万 Token」并非割裂关系，而是微分与积分的因果关系（$\text{History}_{92} \approx \sum_{t=1}^{92} (\text{base}_t + \text{toolResult}_t)$）**：
   - 本人 Agent 看到单轮 `promptChars: 16,398`（其中 `base: 14,758`、`role: 4,692`）只占 `175,000` 总输入的十分之一，推断“剩下的十分之九不在 Bridge 里，而在会话本身”。
   - 穿透 `.v4.jsonl.zstd` 实测可见：主会话 `session-5d06` 累积的 `1.69 MB` `user/message` 中，**超过 `80%–85%` 正是 Bridge 在过去 92 次唤醒里，每次把 `11.6k–14.8k` 字符的静态 `base`（`role` + `bili.briefBlock` + `stickerStrategy` + 规则）作为可变 `user/message` 追加进历史所攒下的存量！**
   - 更致命的是：因为 `base` 被拼在每轮新增 `user/message`（即变动历史的**最末端**），在每轮唤醒的第 1 步（`initial`），这 `~4,800` Token 静态规则由于前方历史前缀已变，**100% 触发高价 `Cache Miss`（Turn 92 Step 1 的 `9,375` 未命中即有约一半源于此）**；随后在同轮 Step 2..7 及后续所有轮次中作为历史底盘反复重算！
   - **推论**：如果只做“每 20 轮开新会话 (`Opt-1`)”而不剥离每轮 `user/message` 中的静态 `base` (`Opt-3`)，仅跑 20 轮仍会在历史中堆出 `20 × 14.8k ≈ 296 KB`（约 `90k+` Token）的重复规则！**`Opt-1`（控积分上限）与 `Opt-3`（砍每轮增量 80%）必须联合实施。**
2. **`recentCount: 100` 并非“每次注入 100 条近期消息”**（重要源码勘误）：
   - 本人 Agent 建议“把快照 `recentCount` 从 `100` 降到 `20`”，但检查 `src/bridge.js:16316` 证实，遥测字段 `recentCount` 记录的是内存环形队列 `wakeState.recentMessages.length` 的缓冲容量；
   - 真正组装唤醒快照的函数 `buildWakeSnapshotV2`（`src/bridge.js:18040-18044`）默认限制 `wakeMessageLimit: 12`、**`wakeRecentLimit: 4`**（只取最后 4 条）、`wakeSelfRecentLimit: 1`、`wakeMaxChars: 6000`。全天 180 次唤醒实测 `snapshot` 平均仅有 **`1,226` 字符**！
   - 因此 **削减 `recentMessages` 队列长度几乎不会降低输入 Token**；`13,482–16,514` 字符里真正不断重复并写入会话历史的噪音，是本文第三节拆解的 **`base` 静态规则与人格层（`11,619` 平均字符）**。
3. **`16.4k` 与 `175k` 之间还包含 `~31.5k` 固定底盘与 `50×` 价格杠杆下的首跳未命中黑洞**：
   - 本人 Agent 受限未能读取 `.v4.jsonl.zstd` 中的 `request/header` 与 `system/message`。实际上 `175k` 中约 **`~26.7k` Token（`124` 个工具 Schema `80,122` 字，含 19 个已禁用的 `onebot-min` 死工具）+ `~4.8k` Token（`dsh-persona`）= `~31.5k` Token** 在 Turn 1 新建会话就会携带；
   - 此外，Turn 92 作为连续活跃会话，Step 2–7 的 `cacheMiss` 只有 `166–642` Token，易让人误以为“KV Cache 效率已经很好，问题只在于基数”；但跨全天来看，由于未命中单价是命中的 **`50×`**，冷群 `proactiveCheck`（`47` 次花 `¥3.07`，54% 零出站）、MCP 抖动与 **`14` 次隐性 `compaction/summary` 重写前缀（`~¥1.76`）** 使得仅占 **`3.54%` 的未命中吞噬了全天真实账单的 `53.4%–57%+`**。
