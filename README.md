# Agent 优化模块 - 高 KV Cache 命中率与低 Token 消耗（Opt-1 ~ Opt-5）

> 面向生产级 AI Agent 的**通用上下文工程（Context Engineering）与成本优化模块**：在**不削弱人格表达、长期记忆、情绪连续性与权限安全**的前提下，系统性解决长会话前缀缓存击穿、静态规则重复入史、`Tool Schema` 膨胀与无效唤醒空转问题。

### 实测效果对比（优化前 vs 优化后）

在真实高频多会话 Agent 生产环境中完整上线 Opt-1 ~ Opt-5 后，账单实测对比如下：

| 阶段 | 实测消费 | 降幅 |
| :--- | :--- | :--- |
| **优化前（左柱）** | `20.23` | 基线（长会话频繁 Compaction + 静态规则重复入史） |
| **优化后（右柱）** | **`7.25`** | **直降 `64.2%`（单期节省 `12.98`）** |

<img src="docs/assets/cost-comparison.png" alt="优化前后实测对比（左：优化前 20.23，右：优化后 7.25）" width="106" />

---

## 一、为什么要做这个模块？（通俗解释 + 专业痛点拆解）

很多 Agent 开发者在接入支持 **KV Cache（键值缓存 / 前缀缓存 Prefix Caching）** 的大模型 API 后，都会遇到一个反直觉的现象：**监控面板显示缓存命中率高达 95% 以上，但每月账单依然居高不下，甚至越聊越贵。**

通过对生产环境全链账本（单日基线 **`¥18.87 / 天`**，单次调用平均输入高达 **`144,013` Tokens**）和 Trace 的逐层拆解，我们发现成本失控并非因为模型单价贵，而是以下四个**结构性架构陷阱**：

### 1. 「高命中率」的假象：50× 价格杠杆下的 `Cache Miss` 黑洞
- **通俗理解**：大多数主流模型（如 DeepSeek）对「命中缓存的 Token（`Cache Hit`）」和「未命中缓存的 Token（`Cache Miss`）」采用悬殊的阶梯定价——未命中单价可达命中的 **10 倍到 50 倍**。这就好比高速公路收费，虽然 96% 的里程打了 0.2 折，但剩下 4% 的高价路段仍然决定了一半以上的总路费。
- **实测分析**：在 `96.46%` 的表面高命中率下，仅占总输入 **`3.54%` 的 `Cache Miss` 贡献了全天 `53.4%` 的真实费用**。

### 2. 「复利滚雪球」效应：把静态规则写进每轮 `user/message`
- **通俗理解**：为了让 Agent 记住人设、说话风格、群聊礼仪或工具使用规范，很多框架会在每一轮对话触发时，把一大段固定说明书（`~8.4K–16.5K` 字符）直接拼接在当前用户消息里发给模型。这不仅让本轮新增内容全部算作 `Cache Miss`，更致命的是——**这些重复说明书会永久留存在对话历史（History）里，在接下来的几十上百轮对话和每次工具续跳中反复计费。**
- **实测分析**：单轮看似只有 `13K–16.5K` 字符的静态 `base`（人设、固定规则、记忆简报），在 92 轮会话中的积分效应（$\text{History}_N \approx \sum_{t=1}^{N} (\text{base}_t + \text{toolResult}_t)$）累计占用了超过 `80%` 的输入体积，导致单次调用平均输入锁定在 `144K+` Tokens。

### 3. 传统 `Compaction / Summary`（上下文压缩）反而会打穿前缀缓存
- **通俗理解**：很多 Agent 依赖框架自带的「长对话自动摘要压缩」来控长，但这是**治标不治本的高价止痛药**。KV Cache 的核心前提是**前缀完全一致（Prefix Exact Match）**；一旦触发压缩，模型不仅要跑一次高价、低缓存命中率的摘要生成，还会直接改写历史前缀，导致后面上百 K 的上下文在下一轮**全量 `Cache Miss`（缓存雪崩）**。
- **实测分析**：当压缩阈值设为 `thresholdRatio: 0.22`（约 `230k` Token 触发）且强制保留 `retainRatio: 0.06` 原文时，压缩后底盘依然高达 `130k–155k`。结果单会话每 `3–7` 轮就会撞线压缩一次（日均 `14` 次，`compaction` 自身缓存命中率仅 `14.8%`），陷入「刚压缩完又爆满」的死循环。

### 4. `Tool Schema` 寄生膨胀与「零产出」无效唤醒
- **通俗理解**：每次调用大模型，框架都会把所有工具的 JSON 定义（`Tool Schema`）附在请求头里，哪怕这轮只是简单闲聊。另外，对于支持定时巡检或主动发言的 Agent，如果每次触发都直接唤醒大模型判断是否该说话，大量「看一眼然后保持沉默」的唤醒同样在白烧高价的首跳 `Cache Miss`。
- **实测分析**：生产环境全量挂载了 `124` 个工具 Schema（共 `80,122` 字符 / **`~26.7k` Tokens**），其中包含 `19` 个已被权限拦截但 Schema 仍每轮注入的死工具（`6,827` 字符/步），在无文件权限的群聊中也照常挂载；同时主动唤醒中有 `54%` 属于零出站空转。

---

## 二、Opt-1 ~ Opt-5 优化体系与核心模块

针对上述四大痛点，本仓库沉淀了一套互锁的五层优化架构（**控存量上限 + 砍每轮增量 + 裁无效工具 + 拦空转唤醒 + 省控制续跳**）：

| 优化代号 | 通俗目标 & 核心机制 | 关键模块与脚本 | 实测 / 设计收益 |
| :--- | :--- | :--- | :--- |
| **Opt-1** | **定期「无损换新本子」：会话轮转 + 原生滑窗交接**<br>不再让单一会话无限膨胀到触发高价 Compaction。达到阈值（私聊 30 轮 / 群聊 25 轮 / 闲置 >4h / 上下文 >=120k）时自动开启干净新会话，仅带入末尾 <=6 条原生对话切片（每条限 150 字，不写情绪数值防止模型“演数值”），配合长期记忆卡实现无感衔接 | `src/session-rotation.js`<br>`scripts/rollback_opt1.mjs`（双回滚点） | 将日均 `14` 次高价 Compaction 压至近 0，从源头切断缓存雪崩（预估省 `¥7.2–¥9.2/天`） |
| **Opt-2** | **轻装上阵：死工具清理与场景 `Tool Schema` 隔离**<br>清理已被拦截却仍在占位的死工具（如 `19` 个无效工具），按主人 / 群聊 / 后台任务等场景物理隔离工具集，并建立工具调用粒度的成本归因（`Tool Cost Attribution`） | `src/tool-cost-attribution.js`<br>`scripts/remote-opt2-remove-onebot-min.mjs` | 每步调用直降 `6,827` 字符并消除无效报错（预估省 `¥1.6–¥2.2/天`） |
| **Opt-3** | **同一件事只说一次：静态上下文去重 + KV 前缀保护**<br>对静态规则计算会话级 `SHA-256` 指纹（`computeStaticHash`），同会话内仅首轮或每隔 N 轮（私聊 25 / 群聊 12）完整注入，其余轮次自动省略；半静态块（表情/印象）用短哈希增量检测；记忆卡按 `recordId` 增量去重 | `src/static-context-dedup.js`<br>`src/prompt-fingerprint.js`<br>`scripts/test-opt3-expand.mjs`<br>`scripts/phase0_static_context_verify.mjs` | 实测每轮稳定净省 **`7,718` 字符**，`base` 从 `14,788` 降至 `6,950` |
| **Opt-4** | **先过本地安检再叫大模型：主动唤醒前置门控**<br>在真正发起昂贵的 LLM 请求前，先用本地零成本规则与概率评分（冷却时间、活跃时段、具体唤醒理由）过滤掉无意义触发 | `src/proactive-gate.js`<br>`src/proactive-policy.js`<br>`src/proactive-config.js` | 砍掉 `54%` 零出站冷唤醒空转（预估省 `¥1.4–¥1.9/天`） |
| **Opt-5** | **少走冤枉路：回合收尾与 `Tool-Continuation` 节流**<br>合并多气泡回复、约束控制动作、裁剪冗余强制等待回合，减少一次交互中多余的串行工具续跳次数 | `src/turn-end-policy.js`<br>`src/turn-guard.js`<br>`src/v2-wait.js`<br>`src/priority-budget.js` | 削减无效串行续跳带来的底盘重算（预估省 `¥1.8–¥2.5/天`） |

### 通用上下文治理与可观测基建（`src/`）

- **统一上下文选择器** [`src/context-selector.js`](src/context-selector.js)：作为唯一真相源（Single Source of Truth），通过 `selectContext()` 完成多槽位裁剪、去重、固定优先级保护（`pinned` / `firstMet`）、再巩固加权（[`src/memory-reconsolidation.js`](src/memory-reconsolidation.js)），以及 **Fail-Closed 权限后置校验 `visible(record, requestCtx)`**，防止跨群聊/私聊越权泄露。
- **双层预算与硬熔断** [`src/token-budget.js`](src/token-budget.js) & [`src/token-guard.js`](src/token-guard.js)：分作用域的 Token 配额告警、静默超限防护（对应 `scripts/test-a2-silent-overbudget.mjs`）与唤醒/出站速率保护。
- **全链路账本归因** [`src/token-ledger.js`](src/token-ledger.js)：记录每次调用的 `cacheHit` / `cacheMiss` / `output` 与费用分桶，支撑精细化成本审计（对应 `scripts/test_cost_calc.mjs`、`scripts/test-cost-summary.mjs`）。

---

## 三、为什么需要 Opt-1 的四个弥补方案？（防失忆、防人格重置的核心设计）

很多开发者一听到“每 25~30 轮强制开新会话（Opt-1）”，第一反应往往是担心：**“切会话之后，Agent 会不会像突然失忆一样，忘记刚才在聊什么、语气变生硬，或者找不到半天前说过的事？”**

如果只是粗暴地清空会话重开，确实会立刻出现**语境断裂、未归档记忆丢失、人格重置、远期细节丢失**四个严重退化。因此，我们在 Opt-1 之上配套了**四个互锁弥补方案**，用不到 **1% 的额外上下文体积**，把跨会话体验拉平至几乎无感：

| 弥补方案 | 解决什么退化痛点 | 核心机制 | 对应仓库代码 |
| :--- | :--- | :--- | :--- |
| **方案一：交接滑窗**<br>*(Handoff / Raw Tail Buffer)* | 新会话空白启动会丢失最后几句的临场语境与代词指代（如“那后来呢？”“他怎么说？”） | 新会话首轮通过 `consumePendingHandoff()` 自动带入上轮末尾 **4~6 条真实对话原文**（每条限 150 字），配合长期记忆卡无缝衔接（不额外花 LLM 费用做低命中摘要） | `src/session-rotation.js`<br>`buildHandoffSummary()` |
| **方案二：轮转前自动沉淀**<br>*(Pre-Rotation Auto-Flush Hook)* | 用户偏好、重要约定往往在闲聊中自然产生，若轮转瞬间直接切断，未入库的临时信息会丢失 | 在 `rotateSession()` 重置会话前，通过 **`onBeforeRotate` 钩子**触发记忆提取与再巩固（`RECONSOLIDATION_RATE = 0.15`），将重要事实沉淀进持久化的 Memory Card / Memory Book | `src/session-rotation.js`（`onBeforeRotate`）<br>`src/memory-reconsolidation.js` |
| **方案三：情绪与精力动量延续**<br>*(Emotional Momentum Carryover)* | 传统切会话会导致“人格重置”——上一秒还在开玩笑或情绪低落，新会话一开瞬间变回客套默认腔 | 将情绪（`valence / arousal / needs`）与精力（`energy`）**独立持久化落盘并按半衰期衰减**，驱动心境一致记忆召回（`moodCongruenceScore`，权重 `0.18`）与主动偏置，跨会话自然延续语调与心理距离 | `src/emotion-state.js`<br>`src/memory-reconsolidation.js` |
| **方案四：按需调阅代替全量常驻**<br>*(On-Demand Recall)* | 担心用户隔了半天突然回溯早先话题（如“上午说的那家店叫什么？”）时答不上来 | 平时只保留轻量上下文，不为了 1% 的回溯概率让 100% 的日常请求背负 150k+ 历史；同时物理保留 `sessionHistory` 并在首轮注入 **「早前历史调阅提示」**，真正需要回溯时再按需调用检索工具查询 | `src/session-rotation.js`（`sessionHistory` & 调阅提示） |

> **工程踩坑实录（方案三的重要演进）**：最初设计曾尝试在新会话首轮直接注入 `[交接心境: ..., valence: 0.35, arousal: 0.20]` 这类显式数值；但生产实测发现，大模型读到精确数字后会把它们当成**“剧本台词注解”**去刻意表演，反而显得生硬做作。因此在最终落地的 `src/session-rotation.js` 与 `src/emotion-state.js` 中，**严禁将 `valence/arousal` 或精力数值写进交接 Prompt**，而是通过独立持久化状态、心境一致的记忆筛选以及原生对话切片，让语气和情绪自然延续。

---

## 四、和一般 Agent 的适配程度（通用性评估与接入指南）

本仓库的代码采用**纯原生 JavaScript（ESM，Node.js 20+，零第三方依赖）**编写，核心算法与具体聊天平台（如 QQ/OneBot）或特定 Agent 运行时**解耦**。

无论你使用的是 **自研 Agent（OpenAI / DeepSeek / Claude / Gemini SDK）**、**多平台聊天机器人**，还是 **LangGraph / AutoGen / OpenClaw 类工作流框架**，适配程度可分为两层：

### 1. 即插即用层（高度通用，90%+ 逻辑可直接复用）

只要你的 Agent 满足「**多轮会话 + 有固定 Prompt 规则 + 调用模型 API**」，以下核心模块可直接作为标准库引入或以同名逻辑移植到 Python/TS：

| 模块文件 | 对一般 Agent 的适配度 | 接入前提 | 典型接入方式 |
| :--- | :--- | :--- | :--- |
| `src/session-rotation.js` | ⭐⭐⭐⭐⭐ **极高（完全通用）** | 你的 Agent 维护 `sessionId` 和近期消息数组 | 每轮前调用 `evaluateSessionRotation()` / `rotateSession()`（支持挂载 `onBeforeRotate` 记忆沉淀钩子）；建新会话时用 `consumePendingHandoff()` 注入交接滑窗 |
| `src/emotion-state.js`<br>`src/memory-reconsolidation.js` | ⭐⭐⭐⭐⭐ **极高（完全通用）** | 希望长程交互 Agent 具备跨会话情绪/精力连续性与心境记忆召回 | 通过 `createEmotionStateManager()` 独立持久化并衰减状态，传入 `selectContext()` 参与 `moodCongruenceScore` 排序 |
| `src/static-context-dedup.js`<br>`src/prompt-fingerprint.js` | ⭐⭐⭐⭐⭐ **极高（完全通用）** | 你能把 Prompt 拆分为「静态规则块」和「动态对话/状态块」 | 调用 `evaluateStaticDedup()` 判断本轮能否省略静态块；模型调用成功后调 `commitStaticDedupState()` |
| `src/context-selector.js`<br>`src/token-budget.js`<br>`src/token-guard.js` | ⭐⭐⭐⭐⭐ **极高（完全通用）** | 需要把记忆/RAG/历史片段装进固定 Token 预算 | 用 `selectContext(ctx, budget)` 裁剪上下文，并接入 `visible()` 做多租户/多场景权限兜底 |
| `src/token-ledger.js`<br>`src/tool-cost-attribution.js` | ⭐⭐⭐⭐⭐ **极高（完全通用）** | API 响应返回标准 Token `usage`（含缓存命中字段） | 在模型响应钩子写入账本，通过 `buildToolAttribution()` 计算每个工具的真实引发成本 |
| `src/proactive-gate.js`<br>`src/proactive-policy.js` | ⭐⭐⭐⭐ **高（适用于主动型 Agent）** | Agent 具备定时巡检、消息监听或主动发言机制 | 在唤醒 LLM 前调用 `evaluateProactiveGate()`，被拦截则直接跳过模型调用 |
| `src/turn-end-policy.js`<br>`src/turn-guard.js` | ⭐⭐⭐⭐ **高（适用于 Tool-Calling Agent）** | Agent 存在多步 `Tool-Continuation` 循环 | 在工具循环守卫中接入 `createTurnGuard()` 与 `assessTurnEnd()`，防止死循环与多余续跳 |

> **微调提示**：`src/session-rotation.js` 中的默认交接提示语 `buildHandoffSummary()` 末尾包含一行针对仿真发送协议的示例提醒（可通过重写或扩展参数替换为你的 Agent 协议），`src/v2-wait.js` 则是针对即时聊天“等对方说完再回复”场景的防碎片化合并策略，非聊天型任务 Agent 可按需忽略该文件。

### 2. 参考范式层（与特定运行时绑定，按思路迁移）

- **`scripts/patches/` 目录与 Opt-2 清理脚本**：这部分脚本（如 `apply_opt1_and_cost.mjs`、`apply_opt45_patches.mjs`、`remote-opt2-remove-onebot-min.mjs`）是为原生产环境 `bridge.js` / DSH / MCP 配置文件编写的落地补丁。
- **一般 Agent 如何借鉴**：
  1. **静态/动态分离**：不要把人设、格式要求、工具说明塞进每轮 `user` 消息里；能放 `System Prompt` 前缀的放前缀，必须在运行时动态组装的规则交由 `Opt-3` 做会话级指纹去重。
  2. **按场景裁剪 `Tool Schema`**：不要给闲聊、子任务或无权限会话注入全局 100+ 工具表；在进入模型前按会话角色过滤 `tools[]` 列表（即 Opt-2 的核心思路）。
  3. **监控 `Cache Miss` 占比而非只看命中率**：重点排查 `System Prompt` 与历史前缀是否被时间戳、动态随机数或压缩摘要频繁打断。

### 3. 模型升级后的适配性变化评估（会变 vs 不会变）

当底层大模型升级到下一代（或切换推理模型 / 跨厂商模型）时，本模块的**底层工程逻辑不会失效，但收益权重与参数阈值会随之改变**：

- **不会变（长期有效，强模型上反而更好用）**：
  - **KV Cache 复利膨胀规律不变**：只要仍采用 Transformer 注意力与 `Cache Hit / Cache Miss` 阶梯计费，“重复静态规则写入历史末尾 = 首跳 Miss + 全程重复计费”以及“压缩改写前缀 = 缓存雪崩”的数学规律就不会失效；上下文窗口变大不等于免费和高速，`Opt-1` + `Opt-3` 依然刚需。
  - **确定性边界不可替代**：`selectContext()` 与 `visible()`（Fail-Closed 权限隔离）、`token-guard.js` 预算熔断、`token-ledger.js` 全链记账属于代码级硬边界，模型越强、接的工具越多，越不能靠 Prompt 自觉替代权限与预算控制。
  - **滑窗交接与按需调阅更稳**：强模型指令遵循与工具检索判断力更高，方案一（滑窗）与方案四（On-Demand Recall）成功率更高，反而更容易把常态底盘压轻；同时强模型更容易照着暗示“演数值”，因此方案三“严禁写入 `valence/arousal` 数值”的红线依然必须保留。
- **会变（升级时需要重校准的 4 个点）**：
  1. **各优化项的省钱权重会改变**：若新模型缩小 `Miss / Hit` 价差倍率或提供更长 TTL 缓存，冷却未命中惩罚权重会下降；若切到高价推理模型（Reasoning Models），成本重心会从 `Cache Miss` 转向 **Thinking 输出 + 工具续跳**，此时 **`Opt-5`（减少多余续跳）与推理强度分层** 的收益占比会大幅上升。
  2. **缓存断点接口形式可能改变**：部分模型靠自动前缀字节匹配（如 DeepSeek），部分依赖显式断点（如 Anthropic `cache_control` / Gemini Context Cache API），切换厂商时需对齐静态块放置位置，避免破坏显式缓存锚点。
  3. **轮转与刷新阈值需要重调**：如 `Opt-1`（`30/25` 轮 / `120k` 红线）与 `Opt-3` 刷新周期应随新模型单价、并发工具调用能力重新校准；且强模型配重工具生态时 **`Opt-2`（Schema 场景隔离）** 会更重要，而 `Auto-Flush` 沉淀任务可路由给更便宜的轻量模型异步执行。
  4. **警惕服务端黑盒压缩/托管会话冲突**：若新模型或 SDK 默认开启服务端自动压缩或 Stateful Session，需显式关闭或将其计费接入 `token-ledger.js`，避免与本地 `Opt-1` 打架并产生账外盲区。

---

## 五、目录结构

```text
.
├── package.json
├── README.md
├── src/                        # Opt-1~5 核心引擎、预算、门控、情绪动量与归因模块（零依赖 ESM）
├── scripts/                    # 单元测试、验证脚本、Opt-1 回滚与 Opt-2 清理脚本
│   └── patches/                # 生产环境落地补丁示例（apply_opt1_and_cost / apply_opt45_patches 等）
└── docs/
    ├── assets/                 # 实测对比截图等文档资源
    ├── phase0/                 # KV Cache 前缀验证与静态上下文审计报告
    └── phase1/                 # 全链 Token 审计与 Opt-1~5 优化方案总报告
```

---

## 六、快速验证（本地运行单元测试）

要求 Node.js 20+（零第三方依赖，纯原生 `node:test`）：

```bash
npm test
```

或单独运行核心模块单元测试（上下文隔离、费用计算、情绪与再巩固、会话轮转与四大弥补机制）：

```bash
node --test scripts/test-context-selector.mjs scripts/test_cost_calc.mjs scripts/test-emotion-memory-v2.mjs scripts/test-session-rotation.mjs
```

---

## 七、核心设计红线（迁移到其他 Agent 时也建议遵守）

1. **绝不盲目调高 `Compaction` 触发上限来“躲压缩”**：例如保持 `thresholdRatio` 在合理安全区（如 `0.22`），避免日常调用长期背负超大上下文，防止 5~20 分钟缓存 TTL 超时后的冷未命中惩罚——正确的解法是用 **Opt-1 主动轮转** 替代被动压缩。
2. **保留轻量核心记忆（`memory-card` / `memory-book`）**：两者合计在实测中不足总输入的 `0.2%`，却是替代超长流水账历史、支撑无损轮转的核心支柱，切忌“为了省 Token 把长期记忆也砍掉”。
3. **跨轮交接只给原生对话切片，不写数值化状态注解**：避免大模型把 `valence / arousal` 等内部数值当成剧本台词去表演。
