[English](OPTIMIZATION_PROPOSAL.en.md) | [简体中文](OPTIMIZATION_PROPOSAL.md)

# OPTIMIZATION_PROPOSAL — 分优先级降本方案与回归风险评估

> **严格守则（遵循第 VI 节边界）**：以下方案 **绝对不删除或削弱** 本人 Agent 核心人格、Memory Card/Book、情绪系统、非恋爱化关系、QQ 社交能力、主动交流能力、好友/群白名单、审批机制、安全规则或文件沙箱边界。
> **计算基数说明**：以实测 **`Europe/London 2026-11-11` 全链基准 `¥18.87/天`**（Ledger `¥17.02` + 账外 `14` 次 Compaction `~¥1.76` + `claudeWake/title` `~¥0.09`）为基数；各条目为**非重叠增量净节省估算**（避免把同一组上下文和同一组调用的节省重复相加）。

---

## 一、分优先级改造方案总表

| 优先级 | 编号 | 优化措施 | 目标问题 | 预期日节省金额 | 预期日节省 Token | 核心回归风险与防护 |
|---|---|---|---|---:|---:|---|
| **P0** | **Opt-1** | **会话生命周期轮转 + 收紧 Compaction 保留底盘**<br/>① 对话会话设置轮转上限（如 `maxTurns: 20–30` 或空闲 `>4h` 新建干净 session，自动继承 Memory Card + Memory Book + 最近 `6–8` 轮摘要——与 本人 Agent 自测“>=20 轮起新会话”建议一致）；<br/>② 若保留 Compaction，将 `qq-chat-v2/agent.cordis.yml` 的 `thresholdRatio` 从 `0.22` (~231k) 降到 `0.10` (~105k)、`retainRatio` 从 `0.06` 降到 `0.025`，避免每 5 轮反复仅清 `46k` 的无效压缩死循环；<br/>③ `slang-learner` (`88k` Token/`66` calls) 改为**每次或每 10 批重置干净无历史会话**（它本就是无状态语料分析）。 | `144K` 超高输入底盘 + `14` 次隐藏 Compaction 击穿缓存 | **`¥7.2 – ¥9.2 / 天`**<br/>*(直接减半主历史体积 + 消除绝大多数循环 Compaction 击穿)* | `~105M – 130M` 输入/天（含消除 ~`2.0M` 极高价未命中） | **风险**：长对话里“20–30 轮前顺口提的细节”需靠记忆卡接住。<br/>**防护**：轮转时自动注入高密度交接摘要 (`handoff summary`, ~800 字) + 保留 `memory-card` / `memory-book` 召回，不丢长期记忆与关系连续性。 |
| **P0** | **Opt-2** | **彻底清理死工具 `onebot-min` + 按 Preset 隔离工具集**<br/>① 从 `cordis.patch.yml` 下线冗余 `mcp-onebot-min`（19 个工具 100% 被白名单禁止却每轮占 `6,827` 字符且曾诱导 `ob_send_text` 报错）；<br/>② 将群聊 `qq-chat` / `slang-learner` 的工具集与主人全功能隔离：`slang` 仅挂 `slang_*`/`web_search`，普通群聊移除 `fs-safe` / `workspace-safe` / `owner_*` / `claude_*` / `qzone_*` 工具暴露（目标将工具 schema 从 `124` 个 `~26.7k` Token 压缩至主人 `~55` 个 `~12k`、群聊 `~25` 个 `~5k`）。 | Turn-1 `~26.7k` 工具 schema 膨胀 + MCP 抖动引发全前缀击穿 + 死工具误调用重试 | **`¥1.6 – ¥2.2 / 天`** | `~22M – 32M` 输入/天（且砍掉工具列表变更引起的冷未命中） | **风险**：误藏正常群聊需要的工具（如 `web_search`/`qq_reply`/`diary`）。<br/>**防护**：对照 `tool-calls.jsonl` 实际调用白名单做只减不误伤校验；主人在私聊保留完整工具能力。 |
| **P0** | **Opt-3** | **改造 `buildWakePromptV2`：静态 `base/role` 从 `user/message` 历史剥离至 System Prefix（不改 `recentCount`）**<br/>① 将占每次唤醒 `~10KB` 的静态条文（`role` `4,807` 字、`bili.briefBlock` `1,089` 字、`stickerStrategy`、`provenance`、`preSleep`、`proactive`、`admin`、`tokenGuard`、`antiAi`、`identity`、`ownerSleep`）移入**按预设不变的 System Prefix** 或**仅在会话 Turn 1 / 规则变更时注入**；<br/>② 后续每次 `wake` `user/message` 仅携带动态 `wakeSnapshot` + 变化字段（实测 `snapshot` 已因 `wakeRecentLimit: 4` 控在 `~1,226` 字符，无需修改 `recentCount` 队列大小），且将波动时间戳（`还差 X 秒` / `上次发言 N 分钟前`）放在消息末尾。 | 每轮往历史里复制 `13.5k–16.5k` 字符，雪球撑爆会话与破坏局部稳定性 | **`¥1.2 – ¥1.8 / 天`**<br/>*(叠加提升跨会话系统前缀共享缓存，且延长会话健康周期)* | `~18M – 25M` 输入/天 | **风险**：模型在超长对话后期淡忘人格或格式规则。<br/>**防护**：与 Opt-1 的 `20–30 轮` 干净会话轮转协同后，会话短且角色始终贴在系统前缀，反而更不易淡忘！ |
| **P1** | **Opt-4** | **`proactiveCheck` 轻量前置门控与冷唤醒止损**<br/>实测 `proactiveCheck` 47 次唤醒花掉 `¥3.0705`（54% 零出站），主因是带着 `100k–190k` 过期 KV Cache 会话唤醒。<br/>① 先用本地纯规则 / `proactive-policy.js`（及已有 `energy` / 活跃度）过滤掉“高概率不发言”或已超 24h 极冷会话；<br/>② 若会话闲置超 `>30m` 触发纯轻量探活（如判断要不要搭话），仅传入最近摘要/记忆卡的**低成本判定（或配合 Opt-1 干净会话）**，确认开口后再完整续接，不再花 `¥0.268` 只为得出“不说话 (`qq_close_conversation`)”。 | `proactiveCheck` 冷缓存空转浪费 | **`¥1.4 – ¥1.9 / 天`** | `~1.5M` 高价未命中 + `~10M` 命中输入 | **风险**：可能略降低极端冷场群的突击搭话频率。<br/>**防护**：保留 `mustReply`（@、引用、私聊、关键词）100% 即时唤醒，仅节流纯随机冷群巡检。 |
| **P1** | **Opt-5** | **削减协议控制往返 + 支持单步批量动作**<br/>① `qq_send_message` 允许明确传数组一次发多条（避免发 3 句话调 3 次工具重算 3 遍 `150k` 上下文）；<br/>② `qq_send_message` 增加可选布尔尾标 `afterAction: 'none' | 'close' | 'set_wake'` 或自动合并 `throughSeq` 已读回执，消除单独的 `qq_mark_read` (`16`次) / `qq_close_conversation` (`95`次) / `qq_set_wake_config` (`64`次) 收尾步；<br/>③ 取消“决定潜水时强制先调用一次 `qq_wait_for_messages(300s)` 再返回决定闭环”的硬性多余步（改为桥接层静音期监听，有新消息再主动唤醒）。 | `87.5%` 模型调用为工具续跳、`qq_wait_for_messages` 489 次居中 | **`¥1.8 – ¥2.5 / 天`** | `~35M – 50M` 续跳输入 + 减少 `~300–450` 次调用/天 | **风险**：批量发消息若节奏过快略显机械；取消沉睡前 5 分钟主动等可能错过对方 30 秒补句。<br/>**防护**：仅取消 300s `sleep wait`，保留短窗口防截断（或由 Bridge 入站防抖合并消息后再唤醒）；气泡间隔仍由 Bridge `sendMessagesV2` 异步延迟发送！ |
| **P1** | **Opt-6** | **分层调整 `reasoningEffort` (`max` -> 分层 `low`/`medium`)**<br/>实测全链路 **58% 的高价 Output (`¥4–¥8/M`) 是 `max` 思考链**，连 `qq_wait_for_messages` 也要思考几百字。日常闲聊 `qq-chat-v2` 降为 `low` / `medium`（仅复杂问答/编码派发保留高档）。 | `¥2.40/天` output 费用中 96% 非用户可见字符 | **`¥0.8 – ¥1.1 / 天`** | 减少 `~180k – 250k` 内部思考 Output/天 | **风险**：过低思考强度可能影响复杂多群指代判断或工具参数准确性。<br/>**防护**：先从 `slang-learner` 和简单闲聊切 `low` 做 A/B 观察，保留复杂任务 / 主人命令 `medium/high`。 |
| **P2** | **Opt-7** | **大工具返回预算封顶与 MCP 重启防抖**<br/>① 对 `fs_read` / `qq_history_search` / `claude_status` / `web_fetch` 的单次返回加硬截断/分页提示（本人 Agent Turn 92 实测第 4 步读 `5,880` 字直接导致第 5 步 `3,373` 未命中，并在后续每一步持续重算收税）；<br/>② `tool-result-pruner` 若触发必改写历史，尽量在 Bridge/MCP 层入栈前控长而非事后中间删剪破坏 KV Cache；<br/>③ 避免运行中频繁重载单边 MCP 导致 `toolsCount` 从 `124 -> 63 -> 124` 闪断重置前缀。 | 单步读取污染全轮缓存 + `developer/message` 突发失效 | **`¥0.5 – ¥0.8 / 天`** | 减少突发 `cacheMiss` 与重算体积 | **风险**：长文件分析/日志排查可能需要多一次分页读取。<br/>**防护**：超阈值返回头尾摘要 + 总行数/字节，需细节时指定 `offset/limit` (`startLine/endLine`)。 |

---

## 二、与 本人 Agent 自测报告（`本人 Agent-上下文成本实测-20261111.md`）的优先级校准

本人 Agent 在自测报告中提出核心质疑：**“任务书把 P0-1 定为调用次数放大（1,597 次），但把上下文从 17 万砍到 8 万每次省一半，而且一次交互都不用牺牲。”** 结合全量账本与 DSH 底层数据复盘后，校准结论如下：

1. **完全采纳 本人 Agent 的第一优先级判断（并完成 `buildWakePromptV2` 逐行验真）**：
   - 本人 Agent 随后自查确认：`wake` 的 `~15,000–16,400` 字符是整段作为 `user/message` 投递并永久留在历史里的“复利”（`role: 4692`、`bili: 1091`、`sticker: 1126`、`style: 169`、`antiAi: 56` 等九成不变）。
   - **为什么选择「静态层前移 / 同会话去重 (`Opt-3`)」而非「下一轮事后替换上一轮历史里的 `user/message`」**：
     - 在 DSH 中，上一轮 `user/message` 后面紧跟着该轮产生的 `7~8` 步 `assistant/message` 与 `tool/result`。若在下一轮去原地修改或替换上一轮的 `user/message`，会导致其后方所有工具步的 Token 偏移量与前缀哈希全部改变，**直接击穿上一轮整条工具链的 KV Cache**！
     - 反之，核查 `src/bridge.js:18430-18433` 可见，代码对 `initialPromptLine` 原本就有现成模式（注释原文：*“只在首次唤醒注入；后续唤醒不再带它 —— 那时它已经在这条 DSH 会话的上下文里了”*），且 `16329` 行的 `withAlignmentContext(key, withSlangContext(promptText))` 还在 `contextTelemetry` 统计之外额外向每轮 `user/message` 头部追加了时间、黑话表与身份对齐块。
     - 因此最佳工程解是：**将通用死规则移入 `dsh-persona` System Prompt，将会话级静态块（`roleLine`、`biliBrief`、`sticker` 策略与目录、`provenance`、`preSleep`、`ownerCrossSession`、`alignment`、`slang` 等 ~`12k–14k` 字符）按 `sessionId + staticHash` 仅在会话首轮（或变更时）注入，后续唤醒的 `user/message` 仅投递 `~1.5k–2.2k` 字符的纯动态层（`wakeSnapshot` + 实时状态 + 动态召回）**。这样既**零篡改历史（100% 保住 KV Cache）**，又直接砍掉 **85%+** 的每轮历史复利增长！
2. **修正 本人 Agent 的 `recentCount: 100` 建议**：源码 `src/bridge.js:18041` 实际仅注入 `wakeRecentLimit: 4` 条近期消息（`snapshot` 均值仅 `1,226` 字），因此**无需修改 `recentCount`**，直接实施 `Opt-3` 即可。
3. **补齐 本人 Agent 未见的「零交互损失」调用压缩空间（`Opt-4 / Opt-5 / Opt-6`）**：
   - 砍调用次数 **不等于** 砍对话交互！全天 `87.5%` (`1,350` 次) 为工具续跳，其中 `489` 次 `qq_wait_for_messages`（含大量睡前 300s 空等后重算 170k 上下文）、`434` 次将同轮多气泡拆成多次 `qq_send_message` 串行调用（其实 `sendMessagesV2` 原生支持单次传数组并异步延迟发泡）、`95` 次 `close` + `64` 次 `set_wake_config`，以及 `47` 次唤醒中 **54% 零出站** 却烧掉 `¥3.07` 高价冷未命中的 `proactiveCheck`。
   - 同时，每次多余的工具续跳都在 `reasoningEffort: max` 下额外产生 ~400 字内部思维链（按 `200×` Cache Hit 的输出单价计费，占全天输出字符 **58%**）。因此合并协议控制步（`Opt-5`）、冷群门控（`Opt-4`）与思考分层（`Opt-6`）同样 **不牺牲任何一次真实聊天交互**，却能再砍掉余下一半费用。

---

## 三、综合预期收益（去重合并后保守区间）

按 `Europe/London 2026-11-11` 全链真实日支出 **`¥18.87/天`** 为基数，各项措施协同落地（非简单算术叠加）后的预期效果：

- **第一阶段落地后（Opt-1 会话轮转 + Opt-2 清理死/冗余工具 + Opt-3 剥离重复提示词）**：
  - 单次平均输入：**`144K` -> 降至 `~45K – 65K` Token**（降幅 ~`55% – 68%`）
  - 隐性 `compaction/summary` 调用：`14` 次/天 -> **`0 ~ 2` 次/天**
  - 日支出预估由 `¥18.87` 降至 **`~¥7.5 – ¥9.5 / 天`**（**降本约 50% – 60%**）
- **第二阶段落地后（叠加 Opt-4 主动门控 + Opt-5 工具步压缩 + Opt-6 `reasoningEffort` 分层 + Opt-7 读取控长）**：
  - 每次唤醒平均调用次数：**`8.6–8.97` 次 -> 降至 `~2.5 – 4.0` 次**
  - 日支出预计可进一步压低至 **`~¥3.5 – ¥5.5 / 天`**（**累计综合降本 ~70% – 80%**），同时完全保留 本人 Agent 核心人格、长短记忆、情绪与社交安全机制。

---

## 四、推荐实施顺序

1. **Step 1（零风险快赢，立即可批复）**：上线 **Opt-2**（下线 `onebot-min` + 隔离群聊/黑话冗余工具）与 **Opt-7 截断规范 (`offset/limit`)** + **Opt-1c (`slang-learner` 每轮无状态隔离)**。
2. **Step 2（核心架构降本）**：部署 **DAILY_COST_MONITORING** 统一埋点（抓全 `compaction` + `claudeWake` + `Europe/London` 口径），随即分阶段开启 **Opt-3**（静态规则进 System Prefix）与 **Opt-1**（`20–30 轮` 或长闲置自动携带记忆卡+交接摘要开新 session）。
3. **Step 3（调用放大治理与 DNR 协同）**：实施 **Opt-5**（`qq_send_message` 合并发泡、去除 300s 强制睡前 wait、合并 `close/wake_config`）、**Opt-4**（冷群主动巡检降频）与 **Opt-6**（`reasoningEffort` 分层）——并在统一口径面板连续观测 48 小时对比回归质量。
