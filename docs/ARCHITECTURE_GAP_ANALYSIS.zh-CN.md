[English](ARCHITECTURE_GAP_ANALYSIS.md) | [简体中文](ARCHITECTURE_GAP_ANALYSIS.zh-CN.md)

# 当前仓库源码与架构差距审计（Architecture Gap Analysis）

- **审计对象**：`agent-token-optimizer (v1)`（本地目录 `agent-token-cache-core`，基线提交 `main @ c0665e3`）
- **审计方法**：逐文件阅读 `src/`（17 个模块）、`scripts/`（单元测试与补丁脚本）及 `docs/phase0`、`docs/phase1`，并实际执行测试脚本验证。**严禁仅凭 `README.md` 断言功能可用性。**

---

## 一、实测基线与重要发现（源码 vs README 核对）

在运行 `node --test scripts/test-context-selector.mjs scripts/test_cost_calc.mjs scripts/test-emotion-memory-v2.mjs scripts/test-session-rotation.mjs` 并逐行检查源码后，发现以下**未在 README 中披露的关键事实**：

1. **致命缺失依赖：`src/model-prices.js` 缺失**：
   - `src/token-ledger.js:38` 与 `src/tool-cost-attribution.js:19` 均执行 `import ... from './model-prices.js'`。
   - 仓库 `src/` 中**不存在 `model-prices.js`**。任何试图直接导入 `token-ledger.js` 或 `tool-cost-attribution.js` 的外部用户都会立即触发 `ERR_MODULE_NOT_FOUND`。
2. **伪测试（False-Green Test）：`scripts/test_cost_calc.mjs`**：
   - 该文件硬编码检查宿主机路径 `/srv/agent/data/state/context-telemetry-bridge.jsonl`；当文件不存在时直接打印 `file not found` 并 `process.exit(0)`（第 4–7 行）。
   - 结果导致 `npm test` 报告通过 `22` 个测试，却**完全没有测试 `token-ledger.js` 与 `tool-cost-attribution.js`**，也未暴露 `model-prices.js` 缺失问题。
3. **测试覆盖盲区巨大**：
   - `src/` 下共 17 个文件，但 `npm test` 仅覆盖了 `context-selector.js`、`emotion-state.js`、`memory-reconsolidation.js`、`session-rotation.js` 这 4 个文件。
   - `static-context-dedup.js`、`prompt-fingerprint.js`、`proactive-gate.js`、`proactive-policy.js`、`proactive-config.js`、`token-budget.js`、`token-guard.js`、`turn-end-policy.js`、`turn-guard.js`、`priority-budget.js`、`v2-wait.js` **在独立仓库内没有任何可运行的单元测试**（README 中提到的 `test-opt3-expand.mjs`、`test-a2-silent-overbudget.mjs` 等依赖不存在的 `./audit-bridge-harness.mjs` 和 `../src/owner-quote.js`）。
4. **Opt-2（Contextual Tool Governance）在 `src/` 中没有运行时实现**：
   - README 将 Opt-2 描述为“场景 Tool Schema 隔离 + 死工具清理”，但核查 `src/` 发现：`tool-cost-attribution.js` 只是**事后遥测归因函数**，真正的 Opt-2 清理只是 `scripts/remote-opt2-remove-onebot-min.mjs` 对生产 YAML 做的静态正则删除补丁，**通用运行时工具治理引擎尚未实现**。
5. **Opt-1（`session-rotation.js`）存在异步沉淀竞态与无回滚缺陷**：
   - 第 117–126 行直接同步调用 `opts.onBeforeRotate(...)`（未 `await`，无错误捕获），随即在第 146–148 行立刻清零 `st.sessionTurns = 0`、清空 `st.staticContextState = null` 并执行 `delete state.sessions[key]`。
   - 若调用方传入异步记忆沉淀函数，新会话创建时记忆写入尚未落盘（写竞态）；若记忆写入或新会话创建失败，旧指针已被删除且状态无法自动回滚。

---

## 二、现有模块逐项审计对照表

| 当前模块 | 源码文件 | 1. 实际实现了什么 | 2. 只有设计/未真正实现 | 3. 与竞品重复 | 4. 独立竞争价值 | 5. 建议集成第三方 | 6. 通用化需重构点 | 7. 保留为 Author Agent 专用插件 |
|---|---|---|---|---|---|---|---|---|
| **Opt-1** | `src/session-rotation.js` (162行) | 轮次/Token/闲置阈值判定 (`evaluateSessionRotation`)、滑窗交接文本拼接 (`buildHandoffSummary`)、同步 `onBeforeRotate`、历史列表保留 (`sessionHistory`) | 异步安全事务轮转、持久化确认、新会话恢复校验、失败回滚；通用协议提示（当前硬编码了 QQ 二代仿真提示） | 低（Headroom/ContextPilot 不管会话轮转状态机） | **极高**：用廉价无损轮转替代昂贵的中间压缩雪崩 | 交接检索可对接 `context-compress` / CCR | 抽离 `private:`/`group:` 硬编码；改为 7 步异步事务状态机；移除 QQ 协议提示硬编码 | QQ 二代仿真提示词模板 |
| **Opt-2** | `src/tool-cost-attribution.js` (147行) + `scripts/remote-opt2-...mjs` | 工具调用次级输入增量归因 (`buildToolAttribution`)、一次性 YAML 删工具脚本 | **运行时 Tool Schema 动态过滤与场景隔离引擎**；Schema 稳定性指纹告警 | 低-中（Headroom 压缩工具输出，但一般不按场景裁剪输入 Schema） | **高**：减少首跳 `26k+` Schema 开销并保住前缀稳定性 | 工具输出体积压缩交由 `Headroom` / `context-compress` | 新增通用的 `ToolGovernance` 模块（按角色/权限/任务类型裁剪 `tools[]` 并检测 Schema 抖动）；修复 `model-prices.js` 依赖 | `onebot-min` 清理脚本与 QQ 群聊工具白名单预设 |
| **Opt-3** | `src/static-context-dedup.js` (153行) + `src/prompt-fingerprint.js` (82行) | 会话级静态块 `SHA-256` 去重、半静态子块短哈希增量对比、`memoryCard` 按 `recordId` 去重、规范化文本指纹 | 自动区分 Provider 原生缓存模式（DeepSeek 自动前缀 vs Anthropic `cache_control` vs Gemini CachedContent）；压缩重构净成本门控 | 中（ContextPilot 有系统提示词去重，Headroom 有 Frozen Prefix） | **极高**：会话内“零篡改历史 + 周期刷新 + 增量指纹”模型 | 可在无损去重之外通过插件调用 `ContextPilot` 质量门控思路 | 泛化 `stickerRaw`/`memberImpressionsRaw` 为通用 `subBlocks: Record<string, string>`；去除 `private:`/`group:` 和中文 QQ 正则硬编码 | `prompt-fingerprint.js` 中的 QQ 号/fake ID 归一化规则 |
| **Opt-4** | `src/proactive-gate.js` (217行) + `proactive-policy.js` (62行) + `proactive-config.js` (113行) | B 类具体原因判定、冷闲置防打扰锁 (`noReplyLocked`)、指数退避、活动时段与群级配置覆盖、纯函数概率偏置 | 通用的事件优先级通道、唤醒去重（Debounce/Coalesce）、Budget-aware 唤醒与外部调度器兼容 | **极低**（几乎所有开源竞品都只在请求发出后做压缩，不管何时该醒） | **极高**：直接砍掉 `50%+` 零产出冷唤醒 | 无直接替代品，可对接 Cron / Webhook 调度 | 泛化 `unread/pendingThoughts/activeTopics` 为通用 `TriggerEvent` 与 `PriorityChannel`；解耦 `emotionBias` 与 `qq`/`group:` 键格式 | QQ 主动社交概率公式、`noReplyLocked`（“对方没回就停敲”）社交规则 |
| **Opt-5** | `src/turn-guard.js` (275行) + `turn-end-policy.js` (90行) + `v2-wait.js` (60行) | 单轮步数上限、重复错误熔断（区分业务拒绝）、同参数死循环检测、副作用幂等记录、停轮恢复 Store、回合收尾评估 | 通用工具执行策略（并发批处理合并、Tool Result 保留与按需恢复）、非 QQ 工具识别接口 | 低（部分框架有简单 `max_steps`，但缺乏预期拒绝区分与副作用幂等续接） | **高**：解决 Tool-Calling Agent 失控续跳与重复副作用 | 长工具输出检索可对接 `context-compress` / `Headroom` | 抽离 `SIDE_EFFECT_TOOL_RE` / `WAITING_TOOL_RE` / 中文错误正则，改为配置注入的 Tool Policy Registry | `v2-wait.js`（QQ 仿真等待防碎片化）、QQ 专用工具名正则 |
| **Token Ledger & Budget** | `src/token-ledger.js` (1025行) + `token-budget.js` (476行) + `token-guard.js` (175行) + `priority-budget.js` (102行) | 幂等采样折叠、行淘汰与汇总防重算、峰谷计价骨架、时间分桶走势、80%/100% 双单位预算熔断、P0/P1/P2 分级预算 | **缺少 `model-prices.js` 导致无法运行**；缺少标准 OpenAI/Anthropic/Gemini/LiteLLM usage 适配器；缺少 Net Savings 与 Cache Rebuild 评估 | 中-高（LiteLLM 已有基础 SpendLogs 与 Team/Key 预算） | **中-高**：在单机/嵌入式场景下极精细的 `(turn, step, retry)` 缓存杠杆账本 | 多租户团队计费与网关汇总交由 **LiteLLM** | 补全多厂商 `model-prices.js`；解耦 `DSH` 事件格式与 `~/.dsh/surfcore` 目录；泛化 `qq/bili/other` scope 为动态自定义 scope | `qq/bili/other` 固定分桶、`surfcoreDir` 路径、中文聊天话术 |
| **Context Selector** | `src/context-selector.js` (835行) | `sourceRef` 溯源、Fail-Closed `visible()` 权限校验、去重与 1-fact-1-card、槽位预算裁剪、敏感词脱敏 | 通用作用域模型（当前耦合 `qq/bili/pet/dreamKind/blood`）、可插拔记忆源接口 | 低-中（多数竞品只按语义/向量相关性裁剪，不强制 Fail-Closed ACL） | **高**：企业/多租户/多频道场景极需确定性权限边界 | 语义检索后端可配合向量库或 FTS5 | 将 `visible()` 拆分为通用 `ScopeACL` 策略 + 可选领域插件；将硬编码文件读取（`biliMemoryPath` 等）改为 `ContextSource` 接口 | `biliMemoryPath`/`dreamKind`/`isBlood`/中文记忆卡格式 |
| **Memory Reconsolidation** | `src/memory-reconsolidation.js` (196行) | 0.15 再巩固系数、情感基调估算、0.18 心境一致评分、独立 JSON 持久化 | 通用 `StateProvider` 接口封装（目前直接被 `context-selector.js` 硬导入） | 极低（属于伴侣型 Agent 特色算法） | 低（仅对拟人/伴侣/长程记忆 Agent 有价值，对 Coding Agent 无意义） | — | 从 `context-selector.js` 核心移除直接依赖，改为可选插件 | **全部保留为 Author Agent / Companion 插件** |
| **Emotion State** | `src/emotion-state.js` (921行) | 情绪/需求衰减、精力（Energy）模型、否决冷却机制、快照防篡改 | 通用 `StateProvider` 接口封装（目前直接被 `proactive-policy.js` 导入） | 极低 | 低（仅面向伴侣/拟人 Agent） | — | 从 `proactive-policy.js` 核心移除直接依赖，改为可选行为偏置插件 | **全部保留为 Author Agent / Companion 插件** |

---

## 三、当前架构的四大核心缺陷

1. **包完整性与可测试性缺陷**：
   - `model-prices.js` 缺失使 `token-ledger.js` 与 `tool-cost-attribution.js` 不可导入。
   - 测试脚本混合了独立单测与宿主机集成脚本，存在伪绿测试（`test_cost_calc.mjs`）。
2. **领域模型与核心算法强耦合**：
   - 会话键假设 `private:*` / `group:*` / `pet`，平台假设 `qq` / `bili`，状态路径假设 `~/.dsh/surfcore`，业务规则含大量硬编码中文提示词与正则，无法直接接入 LangGraph / Claude Code / AutoGen。
3. **缺少统一中间件入口与协议适配器**：
   - 现有模块是 17 个散落的参考函数集合（`README` 也承认只是从 `bridge.js` 抽离的库），缺少统一的 `AgentAdapter` 契约、`UniversalAgentOptimizer` 编排主类以及开箱即用的 Local Proxy 模式。
4. **缺少质量门控与 Benchmark 基准线**：
   - 目前仅有针对 Author Agent 自身 11/9–11/14 生产面板的对照，没有任何标准化、可复现的多场景 Benchmark 套件来证明在不同 Agent 类型（Coding / Tool-calling / Multi-agent）下的 Task Success Rate 与 Net Savings。
