[English](DENIA_STATIC_CONTEXT_OPTIMIZATION_REPORT.en.md) | [简体中文](DENIA_STATIC_CONTEXT_OPTIMIZATION_REPORT.md)

# 本人 Agent 静态上下文优化技术复核与渐进式实施总报告 (`DENIA_STATIC_CONTEXT_OPTIMIZATION_REPORT.md`)

**项目**：本人 Agent / SurfCore / Bridge
**阶段**：Phase 0（只读源码复核、真实 Trace 验证与 Phase 1 最小施工方案设计）
**执行环境**：Google Antigravity（远端生产节点 `<author-agent-prod-host>:/home/ubuntu/surfcore` 零修改）
**生成时间**：`2026-11-12T00:10:00Z`

---

## 一、执行摘要（Executive Summary）

本次 Phase 0 专项审计在不修改任何生产代码、不重启任何服务的前提下，针对《`Agent_Static_Context_Optimization_Review_and_Execution_Plan.md`》提出的全部技术复核问题，直接基于线上部署的 `src/bridge.js`（SHA-256: `5effa20ff102cafec0e1c30a72b0651b3abb61f7ef71c35a2791733abd31d333`）、`context-telemetry-bridge.jsonl` 以及 DSH 会话原始落盘文件 `session.v4.jsonl.zstd` 完成了逐行核验。

### 核心复核结论

1. **证实「唤醒提示词作为 `user/message` 每轮复利追加进会话历史」是第一大结构性冗余源**：
   - 线上实测 `private:1587592535`（`session-5d062d1c...`，91 次唤醒）每次唤醒向 DSH 会话追加一条平均 **`16,011` 字符**（包装后落盘约 `16,187` 字符，`~9,500` Tokens）的 `user/message`。
   - 其中 **12 个会话级静态片段（B 层）** 合计 **`8,416` 字符（约 `4,950` Tokens，占整条唤醒消息的 `52.6%`）** 在同一会话的 91 次唤醒中逐字重复了 91 遍，不仅在每次唤醒的 Step 1 产生 `~4,950` Tokens 的高价 `cacheMiss`（¥2.00/M），而且一旦写入历史就在后续所有轮次的所有工具 Step 中被反复计费，并加速触发高昂的 DSH Compaction。
2. **纠正了原初步分类中的 6 个「伪静态」陷阱（避免了直接按原表施工可能引发的严重功能退化）**：
   - **`stickerLine`（均值 `1,127` 字）后半段并非静态**：实测同一会话内出现 **6 种不同长度**（`868~1,161` 字），因为它读取 `stickerSessionPreferences.recentlyUsedIds(key)` 在每次发送表情包后动态重排候选池。若强行静态化会导致表情包失去轮换能力。
   - **`styleLine`（`66~169` 字，4 种长度）与 `hygieneLine`（`67~212` 字，2 种长度）并非静态常量**：它们根据本轮未读数、轮次状态动态分支，必须留在 C 层。
   - **`memoryCardLine`（`914~2,227` 字，22 种长度）与 `memoryBookLine`（`537~855` 字，9 种长度）是按本轮消息 Query 动态检索的**：必须每轮动态注入（C 层），严禁静态跳过。
   - **`memoryLine` / `memoryStatus`（`0~1,358` 字，12 种长度）含实时 `（X分钟前）` 与递增 `（互动 N 次）`**：每轮都在变化，必须留在 C 层。
   - **`roleLine`（私聊 `4,692` 字 vs 群聊 `5,076` 字）和 `adminLine`（`0` 或 `147` 字 + 称呼偏好）依赖场景、配置与运行时文件**：不能塞进全局写死的 `agent.cordis.yml` System Prompt，而应作为 **B 层（会话级静态块 `[SESSION_STATIC_CONTEXT]`）** 通过全文 SHA-256 指纹动态锚定。
3. **首次在真实 Trace 中捕获到「DSH Compaction 抹除早期 `user/message` 并引发 Step 2 `94,979` `cacheMiss` 缓存击穿」的完整证据链**：
   - 在 `private:1587592535` Turn 95（`w_1794440287561_3`）中，Step 1 总输入达到 `224,797` Tokens（`cacheHit: 214,656`），随即在 Step 1 与 Step 2 之间触发了 DSH `compaction/start` (`seq:7800`) -> `compaction/summary` (`seq:7802`) -> `compaction/end` (`seq:7804`)。
   - Compaction 将早期历史替换为 `<compacted-summary>` (`seq:7803`)，导致紧随其后的 **Step 2 仅剩 `system/message + tools[]`（`39,296` Tokens）命中缓存，而 `<compacted-summary>` 及其后的历史消息产生了高达 `94,979` Tokens 的单步 `cacheMiss`**！
   - **这一实证直接回答了评审文档 2.1-Q4 与 5.2-Item 3**：DSH Compaction **确实会裁掉**首轮注入的 `user/message` 原文！因此 Phase 1 状态机**必须在 `pumpMux` 中监听 `compaction/start|summary|end` 事件并自动清空 `staticContextState`，在下一轮强制重注一次完整静态块**。

---

## 二、评审文档核心问题逐项解答索引

### 1. 上下文组装链路（详见 [`CONTEXT_ASSEMBLY_MAP.md`](./CONTEXT_ASSEMBLY_MAP.md)）
- **组装顺序**：`buildWakePromptV2(key, reason)`（拼装 40 个 `base` 片段 + 唤醒原因尾段）$\rightarrow$ `deliverPromptNow`（追加 `【本次消息快照】` + 折叠提示 + 记录 `contextTelemetry.wake`）$\rightarrow$ `withSlangContext`（在 `offset 0` 置顶 `【当前时间】` + 黑话）$\rightarrow$ `withAlignmentContext`（群聊置顶 `alignmentBriefBlock` 并尾追 `【群聊身份来源】`；私聊尾追 `【身份来源】`）$\rightarrow$ `api.sessions.prompt` 作为一条新的 `user/message` 写入 DSH 会话。
- **提醒补发路径**：当模型回合结束未提交唤醒配置时，`buildWakeReminderPromptV2(key)`（`src/bridge.js:18564`, `21417`）也会再次注入 `roleLine + identityLine + conversationLine + groupSpeechLine + tokenLine`（约 `5,200` 字符）。

### 2. A / B / C 三层分类与作用域边界（详见 `STATIC_DYNAMIC_CLASSIFICATION.md`）
- **A 层（当前已在 DSH `system/message` + `tools[]` 中，占 `39,296` Tokens）**：`agent.cordis.yml` 与 `qq-tool-restrict.mjs` 的指令及 MCP 工具 Schema。Phase 1 **保持不动**。
- **B 层（会话级静态块 `[SESSION_STATIC_CONTEXT]`，私聊实测 `8,416` 字符 / `~4,950` Tokens）**：包含 `roleLine` (`4,692`)、`identityLine` (`179`)、`conversationLine` (`32`)、`versionBaseLine` (`68`)、`provenanceLine` (`382`)、`adminLine` (`501`)、`biliLine` (`1,091`)、`voiceLine` (`148`)、`tokenLine` (`77`)、`antiAiLine` (`56`)、`proactiveLine` (`142`)、`ownerCrossSessionLine` (`480`)、`replyLine` (`194`)、`preSleepLine` (`374`)。
  - **注入策略**：同一 `sessionId` 首轮完整注入；后续轮次若 `sha256('v1|' + sessionId + '|' + staticBlock)` 未变、未发生 Compaction 且距上次完整注入未满 25 轮，则省略这 `8,416` 字符，仅注入 **`118` 字符的 `【会话静态锚点】`**（锁定角色名、当前会话 `key`、主人 QQ、当前 `agentToken`）。
- **C 层（每轮动态上下文，私聊实测均值 `~7,595` 字符，含快照 `1,335` 字符）**：包含 `【当前时间】`、`commitmentLine`、`memoryCardLine`、`memoryBookLine`、`styleLine`、`emotionLine`、`hygieneLine`、`strategyLine`、`dynamicsLine`、`closureLine`、`stickerLine`、`stickerMatchLine`、`statusLine`、`wakeLine`、`memoryLine`、`participationLine`、`tokenGuardLine`、唤醒原因与 `【本次消息快照】`。**100% 保留每轮实时注入**。

### 3. KV Cache 与成本边界校正（详见 [`KV_CACHE_VALIDATION.md`](./KV_CACHE_VALIDATION.md)）
- `withSlangContext` 的 `【当前时间】` 位于每轮新增 `user/message` 的开头，**不会破坏此前历史消息（`214,656` Tokens）的 KV Cache 命中**，但本轮新增的 `user/message` 整条在 Step 1 属于 `cacheMiss`。
- Phase 1 省去每轮 `8,416` 字符静态块的真实价值在于：
  1. **每次唤醒 Step 1 的 `cacheMiss` 直接减少 `~4,830` Tokens（降幅 `~53%`）**；
  2. **会话历史每轮新增体积减半**，使 DSH Compaction 触发间隔从 `18~22` 轮延长至 `34~40` 轮，**减少约 `46%` 的 Compaction 频率及其伴随的 Step 2 `95k cacheMiss` 缓存击穿尖峰**。

### 4. 状态同步、Compaction 恢复与回滚方案（详见 `SESSION_STATE_AND_RECOVERY.md` & `ROLLBACK_PLAN.md`）
- **零漏项指纹**：直接对实时生成的 `staticBlock` 全文计算 `sha256('v1|' + sessionId + '|' + staticBlock)`，任何配置、文件、B站同步或 `agentToken` 变化都会 100% 自动触发重注。
- **原子提交**：仅在 `deliverPromptNow` 的 `submitPromptWithCorrection` 成功返回后才更新 `st.staticContextState` 并持久化至 `qq-social-v2.json`。
- **Compaction 自动重注**：在 `pumpMux` 中监听 `compaction/start|summary|end` 事件，一旦触发立即清空 `st.staticContextState`，确保下一轮自动补发完整静态块。
- **秒级回滚**：通过 `config.json` 的 `socialV2.staticContext.enabled = false` 或还原 `.bak.phase0` 备份文件，可在 15 秒内无损回滚，且无需清理现有会话历史。

---

## 三、Phase 0 全套交付物清单

所有报告均已生成于独立研究目录 `e:\AI\Google\Antigravity\Workspace\research\author-agent-static-context-phase0\`：

1. [`CONTEXT_ASSEMBLY_MAP.md`](./CONTEXT_ASSEMBLY_MAP.md)：完整上下文组装调用链与私聊/群聊真实请求 55 段落偏移映射表。
2. `STATIC_DYNAMIC_CLASSIFICATION.md`：全量 43 个片段的作用域、动态性实测 (`uniqueValuesCount`)、6 项伪静态纠偏与 A/B/C 迁移结论。
3. [`KV_CACHE_VALIDATION.md`](./KV_CACHE_VALIDATION.md)：KV Cache 机制验证、Turn 95 Step 1~36 完整缓存轨迹与 Compaction `94,979` `cacheMiss` 击穿实证。
4. `SESSION_STATE_AND_RECOVERY.md`：`staticContextState` 状态机设计、全文哈希绑定、Compaction 自动重注与重启恢复机制。
5. `PHASE1_IMPLEMENTATION_PLAN.md`：最小、可回滚的 Phase 1 单私聊（`private:1587592535`）施工单（仅改动 `src/bridge.js` 单文件约 55 行 + `config.json` 开关）。
6. `REGRESSION_TEST_REPORT.md`：8 大场景回归测试矩阵与一键验收脚本。
7. `TOKEN_COST_BEFORE_AFTER.md`：`Europe/London` 自然日同口径优化前后对照基线表。
8. `ROLLBACK_PLAN.md`：精确到文件 SHA-256 与一键回滚指令的回滚方案。
9. [`DENIA_STATIC_CONTEXT_OPTIMIZATION_REPORT.md`](./DENIA_STATIC_CONTEXT_OPTIMIZATION_REPORT.md)：本总报告。

---

## 四、下一步执行请示（等待负责人审批）

Phase 0 只读技术复核已全部完成，生产环境保持零修改。
请审阅 `PHASE1_IMPLEMENTATION_PLAN.md`：如确认无误，请指示**「批准执行 Phase 1 单私聊实验」**，我将立即备份生产文件、仅针对 `private:1587592535` 开启 `socialV2.staticContext` 去重开关，并采集实测前后对比数据与回归测试结果向您汇报。
