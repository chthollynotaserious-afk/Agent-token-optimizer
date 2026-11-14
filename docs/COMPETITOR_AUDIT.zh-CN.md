[English](COMPETITOR_AUDIT.md) | [简体中文](COMPETITOR_AUDIT.zh-CN.md)

# 竞品技术审计报告（Competitor Technical Audit）

- **审计日期**：`2026-11-14`
- **审计目标**：评估 5 个核心竞品/生态项目（附带 `rtk-ai/rtk` 生态参考）的技术定位、架构边界、许可证合规性及与 `agent-token-optimizer (v1)`（现演进为 **Universal Agent Optimizer**）的功能重叠度，避免重复造轮子并明确集成 vs 差异化路线。
- **信息可信度标注约定**：
  - `[已核验公开信息]`：来自项目 GitHub 仓库元数据、官方文档或公开技术摘要。
  - `[推理/架构判断]`：基于公开架构与接口特征进行的工程兼容性与定位分析（未在本机安装运行其闭源/第三方包前，不宣称为实测结果）。

---

## 一、竞品总览矩阵

| 项目 | GitHub 地址 | 许可证（审计日 `2026-11-14`） | 核心语言/形态 | 核心定位 | 与本项目重叠度 |
|---|---|---|---|---|---|
| **Headroom** | https://github.com/headroomlabs-ai/headroom | Apache-2.0 `[已核验公开信息]` | Python / Rust / TS（Proxy + SDK + MCP） | 上下文压缩、类型感知裁剪与原文恢复（CCR） | **高**（工具输出/历史压缩、Prefix Cache 保护） |
| **ContextPilot** | https://github.com/msousa202/ContextPilot | MIT `[已核验公开信息]` | Python（SDK Middleware + Proxy + MCP + CLI） | 带质量门控与缓存感知回退的本地请求压缩 | **高**（去重、Prompt Cache 感知、Cost-aware 回退） |
| **context-compress** | https://github.com/Open330/context-compress | 未在公开索引完整暴露（待本地克隆核验 `LICENSE`） `[已核验公开信息]` | TypeScript（MCP Server + Hooks） | Coding Agent 工具输出过滤与 FTS5/BM25 原文索引检索 | **中**（工具结果生命周期、按需检索替代全量入史） |
| **LLMLingua** | https://github.com/microsoft/LLMLingua | MIT `[已核验公开信息]` | Python（PyTorch / Transformers） | 基于小模型/Token 分类器的文本级 Prompt 压缩 | **低-中**（仅文本压缩内核，无 Agent 生命周期/门控） |
| **LiteLLM** | https://github.com/BerriAI/litellm | 核心 MIT；`litellm/enterprise` 为企业协议 `[已核验公开信息]` | Python（OpenAI-compatible Proxy + SDK） | 多厂商 LLM 网关、统一路由、预算、日志与计费 | **中**（Cost Tracking、Budget、Routing 应尽量交由网关层） |
| *(生态补充)* **RTK** | https://github.com/rtk-ai/rtk | CLI/过滤 Apache-2.0；`rtk-engine`/`rtk-proxy` 为 BUSL-1.1 `[已核验公开信息]` | Rust（CLI Proxy） | 面向终端 Coding Agent 的命令输出压缩（`git`/`pytest` 等） | **低-中**（仅终端 CLI 输出层；注意 BUSL-1.1 商业托管限制） |

---

## 二、逐项深度技术审计

### 1. Headroom

- **GitHub**：https://github.com/headroomlabs-ai/headroom
- **许可证**：Apache-2.0（允许商业使用与二次集成）
- **审计日期**：`2026-11-14`

#### 核心机制分析 `[已核验公开信息]`
1. **多模式接入（Proxy / SDK / MCP / CLI）**：
   - Proxy 模式基于 FastAPI（结合 Python/Rust/TS 核心组件），通过替换 `OPENAI_BASE_URL` / `ANTHROPIC_BASE_URL` 拦截请求。
   - 提供 `headroom-ai`（Python / TypeScript SDK）、`headroom wrap` 及 MCP Server（暴露 `headroom_compress`、`headroom_retrieve`、`headroom_stats`）。
2. **类型感知压缩管线（ContentRouter）**：
   - `SmartCompressor / SmartCrusher`：针对大体积 JSON 数组与结构化工具输出做统计筛选，保留异常值、边界结构与错误条目。
   - `CodeCompressor / DiffCompressor`：代码片段与 Patch 压缩。
   - `LogCompressor / SearchCompressor`：终端日志、堆栈跟踪和检索结果压缩。
3. **Live-Zone vs Frozen Prefix（前缀缓存保护）**：
   - 将静态 System Prompt 与早期上下文冻结以保护前缀 KV Cache 命中，仅对高周转的尾部“Live-Zone”（工具返回、文件读取）执行动态压缩。
4. **原文恢复（CCR: Compress-Cache-Retrieve）**：
   - 压缩前的原始内容落本地持久化注册表；当模型需要完整细节时，通过摘要中的哈希/面包屑调用 `headroom_retrieve` 按需取回原文。
5. **LiteLLM 集成**：
   - 支持作为 LiteLLM 的 Guardrail / Sidecar 接入，统一接管 `/v1/chat/completions` 与 `/v1/messages`。

#### 对本项目的启示与边界 `[推理/架构判断]`
- **Headroom 已经解决得很好**：Payload 级的类型感知压缩（特别是 JSON/日志/代码）、CCR 原文恢复闭环、Transparent Proxy + LiteLLM Guardrail 集成。
- **Headroom 未解决的空白**：
  1. **不管理主动唤醒频率（Invocation Control）**：如果 Agent 定时器每秒/每半小时空转唤醒模型，Headroom 只能压单次 Payload，无法在 LLM 调用前零成本拦截无效唤醒。
  2. **不管理跨会话无损轮转事务（Session Lifecycle）**：没有 Turn/Token 阈值主动切新会话 + Pre-rotation Auto-Flush + 失败回滚状态机。
  3. **缺少精细化多租户/多受众 Fail-Closed 记忆隔离与场景级 Tool Schema 物理裁剪**（如死工具剔除、角色/频道工具隔离）。
- **结论**：**绝不重复造 `SmartCrusher` 或通用日志/JSON 压缩器**，应通过 `HeadroomPlugin` 将其作为可插拔的 Payload/Tool-Output 压缩插件集成。

---

### 2. ContextPilot

- **GitHub**：https://github.com/msousa202/ContextPilot
- **许可证**：MIT
- **审计日期**：`2026-11-14`

#### 核心机制分析 `[已核验公开信息]`
1. **四段式本地处理管线（Analyze → Compress → Quality Gate → Forward）**：
   - 本地进程内执行分析（评估消息块的陈旧度 staleness、冗余度 redundancy、相关性 relevance 与密度 density）与压缩（去重 System Prompt、裁剪低相关 RAG 块、历史摘要、去结构噪声）。
2. **质量评分与 Quality Gate（核心亮点）**：
   - 压缩后计算预测质量分（默认阈值 `72/100`）。低于阈值即**自动触发 Safe Fallback**，放弃压缩并原样发送原始 Payload。
3. **Prompt Cache 感知与成本防倒挂（Cost-aware Optimization）**：
   - 显式识别 provider prefix caching（命中折扣约 `0.1x`），防止因为重写早期字节导致缓存失效、反而推高真实账单；若预测净收益为负，同样回退原文。
4. **隐私优先遥测**：
   - 仅在本地处理文本，遥测指标限于 token 数、延迟、质量分、模型 ID 等数值元数据。

#### 对本项目的启示与边界 `[推理/架构判断]`
- **最值得直接借鉴的设计**：
  1. **Quality Gate + Safe Fallback**：任何压缩/裁剪动作前必须过质量与净成本收益双门控；不过门控则无条件透传原文，保证最坏情况下质量零退化。
  2. **净成本约束**：`Opt-3` 保护前缀时虽然天然不改历史，但未来若接入有损压缩插件，必须引入 ContextPilot 式的 Cache Rebuild Cost 核算。
- **ContextPilot 的不足**：主要停留在“单次请求的 Payload 级分析/压缩”，缺少长运行 Agent 的 Session Lifecycle、Tool Execution Loop 止血（`Opt-5`）与 Invocation 门控（`Opt-4`）。

---

### 3. context-compress

- **GitHub**：https://github.com/Open330/context-compress
- **许可证**：公开索引未直接暴露 `LICENSE` 全文（在接入前必须显式核验仓库 `LICENSE` 文件）
- **审计日期**：`2026-11-14`

#### 核心机制分析 `[已核验公开信息]`
1. **定位与技术栈**：TypeScript 实现的 MCP Server 与 Hook 工具集，重点服务 Claude Code、Codex 等 Coding Agent。
2. **工具输出拦截与生命周期管理（PreToolUse / Hook）**：
   - 在冗长的 shell 命令、测试输出、文件读取进入模型主上下文前拦截并浓缩，防止“Context Rot（上下文腐化）”。
3. **SQLite FTS5 + BM25 本地索引检索**：
   - 不做破坏性截断丢弃，而是将完整原始工具输出写入本地 SQLite FTS5 索引库，暴露检索工具供 Agent 按 BM25 关键词相关性按需查回细节。

#### 对本项目的启示与边界 `[推理/架构判断]`
- **关键启发**：工具输出（`Opt-7` 原本只规划了简单头尾截断 + `offset/limit`）不应只是截断！正确的生命周期是：
  `Raw Tool Output -> Local Retention Store (Hash + Index) -> Compact Summary/Handle in Context -> On-Demand Retrieval (Range / Search)`。
- **注意**：TypeScript MCP 生态与本项目（Node.js ESM）天然同构，非常容易通过 MCP 或独立 `ToolResultRetention` 接口兼容或桥接；但因其许可证尚待本地克隆确认，目前仅作为参考模式与可选 Adapter 设计，不得直接抄入源码。

---

### 4. LLMLingua

- **GitHub**：https://github.com/microsoft/LLMLingua
- **许可证**：MIT
- **审计日期**：`2026-11-14`

#### 核心机制分析 `[已核验公开信息]`
1. **v1 (`LLMLingua` / `LongLLMLingua`)**：
   - 使用因果小语言模型（如 `LLaMA-2-7B`）计算 Token 信息熵并做迭代预算裁剪。
   - **缺点**：单次压缩需占用约 `16.6 GB ~ 26.5 GB VRAM`，延迟和算力成本极高，不适合高并发低延迟的在线 Agent 代理层。
2. **v2 (`LLMLingua-2`)**：
   - 通过 GPT-4 数据蒸馏将压缩转为双向编码器（`XLM-RoBERTa-large` / `mBERT`）上的 **Token 分类问题**（单次前向推理）。
   - 压缩速度比 v1 快 `3x–6x`，峰值显存降至约 `2.1 GB VRAM`，端到端（压缩 + 目标 LLM 推理）加速 `1.6x–2.9x`，且具备较好的 CPU / ONNX 移植可行性。

#### 对本项目的启示与边界 `[推理/架构判断]`
- **绝不自行实现 Token 级神经网络剪枝**：训练与蒸馏编码器模型不是中间件的职责。
- **是否将其作为核心依赖？—— 否！**
  1. 在 **KV Cache 前缀敏感场景**（如 DeepSeek / Claude 长会话），Token-level 删除会直接破坏前缀字节对齐并可能损坏代码/JSON 语法；
  2. 它仅适用于**一次性大段非结构化文本/RAG 文档注入前**（例如长文档摘要预处理），作为可选重型 Python Sidecar 插件，而非默认在线热路径。

---

### 5. LiteLLM

- **GitHub**：https://github.com/BerriAI/litellm
- **许可证**：核心 MIT；`litellm/enterprise` 目录为企业级商业协议
- **审计日期**：`2026-11-14`

#### 核心机制分析 `[已核验公开信息]`
1. **Multi-provider Gateway**：OpenAI 兼容统一代理，路由 100+ 提供商（OpenAI、Anthropic、Vertex、Bedrock、DeepSeek、本地 vLLM 等），内置负载均衡与模型 Failover。
2. **Cost Tracking & SpendLogs**：基于内建 `model_cost` 映射表与 PostgreSQL 记录每次请求的 Token 消耗与花费，响应头可返回 `x-litellm-response-cost`。
3. **层级预算管理**：支持 Virtual Key（个人）、Team（团队）和 Global 级别的金额上限与 RPM/TPM 限流，超限自动拦截并触发 Webhook。

#### 对本项目的启示与边界 `[推理/架构判断]`
- **职责划界（极重要）**：
  - **应交给 LiteLLM / Gateway 层的能力**：多厂商协议转换、API Key 池与负载均衡、Provider 级 Failover、组织级/团队级账单汇总与集中告警。
  - **Optimizer 自身必须保留的能力**（LiteLLM 做不到）：
    1. **Agent 语义与生命周期决策**（何时轮转会话、何时归档记忆、何时注入 Handoff）；
    2. **唤醒门控（Invocation Gate）**（在请求根本还没发往网关之前就决定“不叫模型”）；
    3. **Tool Schema 场景隔离与工具循环止血（`Opt-2` / `Opt-5`）**；
    4. **面向单轮与缓存经济性的精细核算**（Cache Hit/Miss 价差杠杆分析、优化前后 Net Savings 归因——LiteLLM 侧重账单记账，不评估“某次压缩是否打穿了缓存导致净亏钱”）。
- **结论**：Universal Agent Optimizer 应**兼容** LiteLLM（作为上游 Proxy 或下游 Provider），而不是重新造一个 100+ 厂商的模型网关。

---

### 6. 生态补充：RTK (Rust Token Killer)

- **GitHub**：https://github.com/rtk-ai/rtk
- **许可证**：CLI 与基础过滤 Apache-2.0；`rtk-engine` 与 `rtk-proxy` 为 BUSL-1.1（限制作为托管商业服务提供）
- **定位**：Rust 编写的本地 CLI 输出过滤代理（主要压缩 `git`、`pytest`、`docker` 等终端命令输出）。
- **集成建议**：通过独立 `RTKPlugin`（调用本地 CLI/Hook）提供可选适配，注意在开源核心文档中明确提示 BUSL-1.1 的商业服务分发限制，绝不将 BUSL 代码静态合入本项目核心。

---

## 三、功能重叠与生态位总结

```text
[Agent Runtime (Claude Code / LangGraph / AutoGen / OpenClaw / Custom)]
        │
        ▼
┌──────────────────────────────────────────────────────────────────────┐
│  Universal Agent Optimizer (本项目独特生态位)                         │
│  1. Autonomous Invocation Controller (Opt-4: 请求前拦截零产出唤醒)     │
│  2. Session Lifecycle Engine (Opt-1: 事务化无损轮转 + 记忆沉淀 + 恢复) │
│  3. Static/Dynamic Dedup & Cache Economics (Opt-3: 前缀保护与净收益)   │
│  4. Contextual Tool Governance & Loop Guard (Opt-2 + Opt-5)          │
│  5. Optional State Provider Interface (去 Author Agent 耦合的状态扩展点)     │
└───────┬──────────────────────────────────────────────┬───────────────┘
        │ (Payload / Tool Output Compression Plugins)  │ (Provider Gateway)
        ▼                                              ▼
  [Headroom / context-compress / LLMLingua-2]     [LiteLLM / Direct APIs]
  (通过 Adapter + 单一压缩保护 + 质量门控按需调用)   (路由 / 鉴权 / 多厂商转发)
```

- **核心结论**：市面上已有强大的 **单次请求压缩器**（Headroom、ContextPilot、LLMLingua-2）、**工具检索库**（context-compress）和 **多模型网关**（LiteLLM），但**没有一个开源中间件把「Agent 生命周期（Session Rotation + Handoff）+ 唤醒门控（Invocation Control）+ KV Cache 净成本经济学（Cache Economics）+ 工具循环治理（Tool Governance & Turn Guard）」整合成统一的 Agent Runtime Optimization Middleware**。这正是本项目最坚固的差异化护城河。
