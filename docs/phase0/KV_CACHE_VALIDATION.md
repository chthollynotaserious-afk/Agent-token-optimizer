[English](KV_CACHE_VALIDATION.en.md) | [简体中文](KV_CACHE_VALIDATION.md)

# 本人 Agent KV Cache 机制验证与成本边界校正报告 (`KV_CACHE_VALIDATION.md`)

## 1. 评审文档第 4 节三项核心校正结论（基于线上真实 Trace 实证）

本报告严格遵循评审文档第 4 节要求，使用线上 `/srv/agent/data/state/context-telemetry-bridge.jsonl` 与 `session-5d062d1c-b11c-4cec-869f-7db1148cf4e0.v4.jsonl.zstd` 的实测数据，对前期讨论中的三项边界问题作出精确校正。

---

### 1.1 校正一：`withSlangContext` 将 `【当前时间】` 放在 `user/message` 段首到底破坏了什么？没有破坏什么？

#### 事实核查
- 在 `src/bridge.js:16329` 中，每次唤醒投递的文本经过 `withAlignmentContext(key, withSlangContext(promptText))` 包装，导致 `【当前时间】2026/11/11 23:38:07（UTC）` 位于**当前轮新增的 `user/message` 的第 `0` 个字节**。
- 在 DSH 的 OpenAI/DeepSeek 兼容消息数组中，单次请求的完整序列为：
  ```text
  [0] system/message + tools[]          (~39,296 Tokens，会话创建时固定)
  [1] Turn 1 user/message               (历史已落盘，时间戳固定不变)
  [2] Turn 1 assistant/message + tools  (历史已落盘，固定不变)
  ...
  [k-1] Turn (N-1) assistant/message    (历史已落盘，固定不变)
  [k] Turn N user/message               <-- 【当前时间】在这里的开头！
  ```

#### 精确结论
1. **它【没有】破坏历史前缀的 KV Cache（`[0] .. [k-1]` 全部命中缓存）**：
   - 证据：在 `private:1587592535` Turn 95 Step 1（`ts: 1794440292482`）中，尽管 `Turn 95 user/message` 开头带有全新的 `【当前时间】2026/11/11 23:38:07（UTC）`，但模型 API 返回：
     - `cacheHit = 214,656` Tokens（占总输入 `224,276` Tokens 的 **`95.71%`**）
     - `cacheMiss = 9,620` Tokens
   - 在 `group:588475979` Turn 38 Step 1（`ts: 1794440692118`）中：
     - `cacheHit = 115,584` Tokens（占总输入 `122,754` Tokens 的 **`94.16%`**）
     - `cacheMiss = 7,170` Tokens
   - 证明历史消息中的 `【当前时间】` 一旦写入历史就不再变动，因此 `[0] .. [k-1]` 的前缀 KV Cache 完好无损。
2. **它【真正】造成的损耗是什么？**
   - 它只会阻止**当前轮新增的这条 `user/message`（`[k]`）内部的前缀对齐**（由于 DeepSeek 按 `64 Tokens` 块对齐前缀缓存，且 `[k]` 紧接在每轮不同的 `[k-1] assistant/message` 之后，即使把 `【当前时间】` 移到 `[k]` 末尾，`[k]` 在 Step 1 中本来也是 `cacheMiss`；而在同一 Turn 的 Step 2..Step M 工具循环中，`[k]` 的 `【当前时间】` 已固定，Step 2+ 依然能 `100%` 命中 `[k]` 的缓存）。
   - **因此**：优化静态重复块的核心收益**不是**靠移动 `【当前时间】` 提升 Step 1 缓存命中率，而是**直接砍掉每轮追加进会话历史的 `8,416` 字符（约 `4,950` Tokens）静态文本**，从而消除：
     1. 每次唤醒 Step 1 的 `~4,950` Tokens **未命中输入（`cacheMiss` 单价 ¥2.00/M，是命中价的 10 倍）**；
     2. 这 `~4,950` Tokens 一旦进入历史后，在后续所有轮次的所有 Step 中被反复按缓存命中计费（`¥0.20/M`）的**复利滚雪球效应**。

---

### 1.2 校正二：单次调用平均输入 `141,994` Tokens 的构成拆解（防止高估单一定点优化跌幅）

以 `private:1587592535` 线上实测数据拆解 `140k～224k` 输入窗口的真实构成：

| 组成部分 | 实测 Token 规模 | 占 `224,276` (Compaction 前峰值) 比例 | 占 `134,403` (Compaction 后基线) 比例 | 证据来源 |
|---|---:|---:|---:|---|
| **1. `system/message` + MCP `tools[]` Schema** | **`39,296` Tokens** | `17.5%` | `29.2%` | Turn 95 Step 2 Compaction 后前缀仍命中的 `cacheHit = 39,296` Tokens |
| **2. `<compacted-summary>`（历史压缩摘要块）** | **`~12,000～18,000` Tokens** | `~6.7%` | `~11.2%` | `seq:7803` `<compacted-summary>` + `seq:7806` `Current runtime context` |
| **3. 未压缩窗口内的历史 `user/message` 中的 B 层静态块累积** | **`~80,000～115,000` Tokens**（取决于距上次 Compaction 的轮数 `16～23` 轮） | `~45.0%` | `~36.0%` | 每轮 `user/message` 含 `8,416` 字符（`~4,950` Tokens）B 层静态块，累积 `16～23` 轮即达 `80k～114k` Tokens |
| **4. 未压缩窗口内的历史 C 层动态块 + 快照 + `assistant` 思考/工具调用 (`tool/call` + `tool/result`)** | **`~65,000～85,000` Tokens** | `~30.8%` | `~23.6%` | 每轮 C 层动态块（`~3,600` Tokens）+ 多步工具调用（均值 `8.97` 步/唤醒，每步新增 `200～1,500` Tokens） |

#### 关键边界认识
- **仅实施「会话级静态上下文去重（Phase 1）」后，平均输入 Token 不会从 `141,994` 直接跌到几千**！
- 原因：
  1. `system/message + tools[]` 固定占 **`39,296` Tokens**；
  2. DSH `agent.cordis.yml` 当前配置 `compaction.thresholdRatio = 0.22`（在 `maxTokens = 256,000` 或模型上下文窗口下，约在 `224k～231k` Tokens 时才触发 Compaction）；
  3. 去掉每轮 `~4,950` Tokens 的 B 层静态重复注入后：
     - **立竿见影的确定性收益 ①**：每次唤醒 Step 1 的 `cacheMiss` 输入直接减少 **`~4,950` Tokens**（降幅约 **`50%`**，从 `~9,620` 降至 `~4,670` Tokens）；
     - **确定性收益 ②**：会话历史的膨胀速度减半（原本每轮膨胀 `~9,500` Tokens，去重后每轮仅膨胀 `~4,550` Tokens），使得触发 DSH Compaction（每次耗费 `~95,000` `cacheMiss` Tokens！）的频率降低约 **`45%～50%`**，且同轮次下的历史 `cacheHit` 基数下降约 **`35%～45%`**。

---

### 1.3 校正三：Turn 95 完整 36 步 Trace 实证——Compaction 如何产生单次 `94,979` `cacheMiss` 尖峰

以下是 `private:1587592535` 最新一次唤醒 `w_1794440287561_3`（Turn 95，共 36 步模型调用）的实测 Token 轨迹（提取自 `context-telemetry-bridge.jsonl` 与 `session-5d062d1c...v4.jsonl.zstd`）：

| Step | 时间戳 (`ts`) | 事件说明 | `cacheHit` | `cacheMiss` | `output` | `totalTokens` | 缓存命中率 |
|---:|---:|---|---:|---:|---:|---:|---:|
| **Step 1** | `1794440292482` | 唤醒首调（投递 `17,042` 字符 `user/message`） | `214,656` | **`9,620`** | `521` | `224,797` | `95.71%` |
| *(Compaction)* | `1794440295280` ~ `1794440320585` | **DSH 触发 `compaction/start` (`seq:7800`) -> `compaction/summary` (`seq:7802`) -> `compaction/end` (`seq:7804`)**：由于 Step 1 `totalTokens (224,797)` 触及阈值，DSH 压缩早期消息，总上下文从 `224.8k` 降至 `134.4k` | *(账外压缩调用)* | *(账外)* | *(账外)* | — | — |
| **Step 2** | `1794440322456` | Compaction 后首步：仅 `system/message + tools[]` (`39,296` Tokens) 命中前缀缓存；`<compacted-summary>` 及其后的历史消息 (`94,979` Tokens) 全部变为未命中！ | `39,296` | **`94,979`** | `128` | `134,403` | **`29.27%`** |
| **Step 3** | `1794440326290` | `<compacted-summary>` 已写入 KV Cache，命中率立即恢复 | `134,400` | `215` | `331` | `134,946` | `99.84%` |
| **Step 4** | `1794440330433` | 工具调用步进 | `134,784` | `248` | `128` | `135,160` | `99.82%` |
| **Step 5..10** | `...354181` ~ `...502119` | 6 次工具步进（每次 `cacheMiss` 仅 `200~582` Tokens） | `135,040` -> `137,344` | `200~582` | `128~452` | `135,730` -> `138,234` | `99.6%~99.8%` |
| **Step 11** | `1794440512856` | 读取报告长文本工具返回 | `138,112` | `1,274` | `1,658` | `141,044` | `99.09%` |
| **Step 12..36** | `...517729` ~ `...630362` | 后续 25 次工具与回复步进 | `140,928` -> `152,320` | `143~2,037` | `128~787` | `141,292` -> `152,602` | `98.6%~99.9%` |

> [!WARNING]
> **重大实证发现（Step 2 的 `cacheMiss = 94,979` Tokens）**：
> - 仅 **Step 2 这一步**（因 Compaction 重写历史前缀导致的缓存击穿），就产生了 **`94,979` 个 `cacheMiss` Tokens**（按 ¥2.00/M 计费，单步未命中成本 ¥0.19，相当于平时 **400 步**工具调用的 `cacheMiss` 总和）！
> - 加上 DSH 执行 `compaction/summary` 自身消耗的约 `224k` 输入调用，**每发生一次 Compaction 的真实代价高达 ¥0.25～¥0.30**。
> - 而 Compaction 之所以频繁触发，正是因为每轮 `user/message` 塞入了 `8,416` 字符（`~4,950` Tokens）的 B 层静态文本！通过 Phase 1 将 B 层静态文本改为会话首轮/变更时注入，不仅每轮 Step 1 省下 `~4,950` `cacheMiss` Tokens，还能把 Compaction 触发间隔拉长近一倍，直接砍掉一半的「Compaction + Step 2 95k `cacheMiss` 缓存击穿」双重尖峰！
