[English](DIFFERENTIATION.md) | [简体中文](DIFFERENTIATION.zh-CN.md)

# 核心差异化定位与集成策略（Differentiation Strategy）

- **产品定位**：**Universal Agent Optimizer** — *An open-source optimization middleware for long-running AI agents.*
- **核心原则**：不以“字符压缩率”为目标，而以 **真实 API 净成本下降（Net Savings）+ 任务质量零退化（Zero Quality Regression）+ 确定性上下文治理** 为核心价值。

---

## 一、四项核心差异化技术支柱

### A. Agent Context Lifecycle Management（上下文生命周期管理）

业界多数竞品（如 Headroom、ContextPilot、LLMLingua）集中在“单次请求发出前怎么把 Prompt 压小”。但长运行 Agent 真正的成本灾难来自**会话无限膨胀 + 框架被动 Compaction 引发的 KV Cache 雪崩**（在 `KV_CACHE_VALIDATION` 实测中，单次 Compaction 导致后续 Step 2 产生 `94,979` 个 `cacheMiss` Tokens）。

我们的解法不是更好的摘要压缩，而是**用低成本的会话生命周期轮转替代高价的中间摘要压缩**，并将当前 `Opt-1` 的同步钩子升级为 **7 步安全轮转事务**：

1. **暂停状态变更（Freeze / Acquire Turn Lock）**：获取会话写入锁，阻止轮转期间并发入站消息修改会话状态。
2. **完成必要记忆沉淀（Await Async Memory Flush）**：`await onBeforeRotate(...)` 将关键事实、未完成任务与偏好写入持久化 Store（允许路由至轻量模型或本地规则提取）。
3. **验证持久化成功（Verify Persistence）**：确认存储返回的写入回执或版本递增，防止竞态丢记忆。
4. **保存交接状态（Persist Handoff Envelope）**：生成无数值注解的尾部原生对话切片（Tail Buffer）+ 按需回溯索引指针，写入原子化 Handoff 存储。
5. **创建/切换新会话（Activate Next Session）**：重置轮数与会话级去重状态，保留静态 System Prompt 与 Tool Schema 前缀不变以延续跨会话前缀缓存（Prefix Stability）。
6. **验证上下文恢复（Verify Context Recovery）**：在新会话首轮注入并校验 Handoff 消费成功与关联状态可读。
7. **失败回滚（Transactional Rollback）**：第 2–6 步任一环节失败时，立即恢复旧 `sessionId`、旧 `staticContextState` 与原轮数计数，保留旧会话继续运行，并记录审计日志。

---

### B. Autonomous Invocation Optimization（自主唤醒优化）

压缩器无法阻止“本不该发生”的 LLM 调用。对于支持定时巡检、监听事件流、多 Agent 心跳协同的长运行 Agent，**50%+ 的唤醒是零产出的空转**，且每次空转都踩在过期缓存后的高价 `Cache Miss` 上。

`Opt-4` 演进为独立的 **Invocation Controller**：
- **Event-based Trigger & Wake-up Deduplication**：短时间窗口内对同一会话/任务的重复事件合并防抖（Coalesce），避免多次触发重复模型调用。
- **Local Rule Evaluation & Exponential Cooldown**：先跑零成本本地规则、活跃时段判断与连续静默指数退避（Silent Streak Backoff）。
- **Priority-based Bypass Channel（高优先级旁路通道）**：强制区分 `URGENT / USER_DIRECT` 与 `LOW / PROACTIVE_PATROL`——真实用户交互、直接提及、阻塞性错误或到期关键承诺**绝不被静默冷却或日常自主配额误杀**。
- **Budget-aware Invocation**：与 Token/Cost 预算联动，当低优先级预算耗尽时自动降级或挂起定时任务，仅保留高优管理/人工介入通道。

---

### C. Cache-Aware Cost Optimization（缓存感知的真实成本优化）

**减少 Token 数 ≠ 省钱**。如果一个压缩器改动了历史消息或 System Prefix 的前 50% 字节，导致 100k Tokens 的前缀缓存全部失效并按 `10x–50x` 的 `Cache Miss` 计价，即使 Token 总量减少 30%，总账单也会暴涨。

核心度量公式：
$$\text{Net Savings} = \text{Baseline Cost} - \text{Optimized Total Cost}$$
其中：
$$\text{Optimized Total Cost} = \text{Provider API Cost}_{\text{optimized}} + \text{Compression / Judge Overhead} + \text{Cache Rebuild Penalty}$$

设计准则：
1. **显式区分实测（`observed`）与推算（`estimated`）**：直接读取 Provider 返回的 `cached_tokens` / `cache_read_input_tokens` / `cache_creation_input_tokens` 才标记为 `observed`；无响应字段时才做前缀匹配率推算并严格标注 `estimated`。
2. **厂商缓存机制差异化适配**：
   - DeepSeek / OpenAI：自动前缀匹配（需严格保护前序消息与 `tools[]` 字节不变，且按 64/128 Token 块对齐）。
   - Anthropic Claude：依赖显式 `cache_control` 断点（TTL 通常 5m/1h），需维护断点位置稳定，并计入 `cache_write` 额外溢价。
   - Google Gemini：显式 Context Cache API vs Implicit Caching，需计入存储 TTL 费用。
   - Local LLM (vLLM / llama.cpp)：关注本地 KV Cache 复用率与首字延迟（TTFT）节省，API 费用记 `0`。

---

### D. State-Aware Context Governance（状态感知的上下文治理）

通用 Agent 优化核心**不能强制要求**任何 Agent 具备“人格、情绪或伴侣关系记忆”。但对于需要长期个性化或精细权限隔离的 Agent，上下文管理不能退化为简单的文本拼接。

我们通过 **可选 `StateProvider` 接口** 实现分层治理：
- **核心强制层（通用）**：
  - `Scope / Access Control`：Fail-Closed 的多租户/多频道/多角色可见性校验（`canAccessScope`），绝不让私密记忆或内部工具上下文跨界泄露。
  - `Priority & Versioning`：固定锚点（`pinned`）槽位保护、同 `key` 版本覆盖（`superseded` / `effectiveFrom`）与过期淘汰（`expiresAt`）。
- **可选扩展层（`StateProvider` 插件）**：
  - `NoopStateProvider`（默认，零状态开销，适合 Coding Agent / 无状态任务流）。
  - `CompanionStateProvider`（将原有的 `emotion-state.js` 与 `memory-reconsolidation.js` 封装为可选实现示例，仅供 Author Agent 或拟人伴侣类 Agent 按需挂载）。

---

## 二、明确的“不重复开发”清单与推荐集成

| 能力领域 | 决策 | 推荐集成对象 | 原因 |
|---|---|---|---|
| **多厂商统一路由 / Key 池 / 组织账单** | **不自研** | **LiteLLM** | LiteLLM 已覆盖 100+ 厂商格式与企业团队限流，Optimizer 应只做语义/生命周期优化并兼容其 Proxy。 |
| **JSON / 代码 / 终端日志通用压缩引擎** | **不自研** | **Headroom** / **RTK** | `SmartCrusher` 与 `RTK` 已经针对结构化 JSON 与 CLI 输出做了深度工程打磨，直接通过 Plugin Adapter 调用。 |
| **Neural Token-level 剪枝** | **不自研** | **LLMLingua-2** | 需要蒸馏编码器模型，仅适合特定 RAG 长文档预处理场景作为可选插件。 |
| **工具输出全文索引（FTS5/BM25）** | **不重造重型引擎** | **context-compress**（或轻量本地 Store） | 核心库内置零依赖的 `ToolResultRetentionStore`（Hash + 行范围 + 关键词切片），需要高级 FTS5/BM25 时通过 MCP/Adapter 桥接 `context-compress`。 |
| **有损压缩安全门控范式** | **吸收借鉴** | **ContextPilot** | 将其“Quality Score + Cache Rebuild Gate + Safe Fallback”直接抽象为本项目的核心管线校验器。 |

---

## 三、商业化与开源定位可行性评估（Open Core）

### 需求与壁垒分析
- **真实需求**：从“个人开发者跑 Claude Code / OpenClaw 烧钱”到“企业级多 Agent 客服/研发工作流账单不可控”，痛点从“降 Token”转向“可控预算、可解释成本、质量零回归”。
- **竞争壁垒**：单纯的文本压缩算法极易同质化；**跨模型 Cache 经济学 + 会话生命周期事务 + 工具权限治理 + 可审计 Benchmark 回归体系** 才构成工程壁垒。

### Open Core 梯度评估

| 层级 | 建议能力边界 | 商业化可行性评估 |
|---|---|---|
| **Community（MIT 开源核心）** | Core Optimization Engine（生命周期、去重、唤醒门控、工具治理、预算熔断）、基础 Adapter（OpenAI/Anthropic/MCP/LangGraph）、本地 JSONL Token Ledger、单机 Proxy、CLI、Python 客户端 | 极高。必须保持**完全开源、零外部强依赖、可独立运行**，这是赢得开发者社区信任与标准化的前提。 |
| **Developer（可选个人增强/云端工具）** | 交互式成本与 Cache Hit 可视化面板、跨项目对比报告、自动 Benchmark 回归流水线 | 中。适合以 SaaS 观测看板或桌面工具形态提供，但不可阉割 Community 的本地 CLI 统计能力。 |
| **Team（团队协作）** | 跨项目/多 Agent 统一预算池、团队策略模板分发、异常唤醒与缓存雪崩告警 | 高。开发团队在多 Agent 并行研发时对集中观测和回归阻断有明确付费意愿。 |
| **Enterprise（企业私有化）** | 私有化 Proxy 集群、RBAC 与 Fail-Closed 数据隔离审计日志（SOC2/合规）、定制 Provider 定价与 SLA 支持 | 最高。金融/企业内网运行长程 Agent 时，**权限边界审计 + 成本可追溯**比单纯省 10% Token 更具采购驱动力。 |
