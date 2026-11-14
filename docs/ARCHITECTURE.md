# Universal Agent Optimizer 通用架构设计

本文档定义 **Universal Agent Optimizer** 从单一项目库向独立、可扩展的通用 Agent Runtime Optimization Middleware 演进的架构规范。

---

## 一、总体分层架构

```text
+-----------------------------------------------------------------------+
|  1. Integration Layer (Embedded SDK Adapters / Local HTTP Proxy)      |
|     OpenAI-Compatible | Anthropic | LangGraph | MCP | Custom Agent    |
+-----------------------------------+-----------------------------------+
                                    |
                                    v
+-----------------------------------------------------------------------+
|  2. Core Optimization Engine (Zero Required External Dependencies)    |
|     - Invocation Controller (Opt-4: Coalesce / Cooldown / UrgentPass) |
|     - Session Lifecycle Controller (Opt-1: 7-Step Safe Rotation)      |
|     - Static Context Dedup (Opt-3: Session Fingerprint & SubBlocks)   |
|     - Context Selector & Scope ACL (Fail-Closed Visibility + Budget)  |
|     - Tool Schema Governance & Turn Guard (Opt-2 + Opt-5)             |
|     - Cache Economics Engine (Observed vs Estimated Net Savings)      |
+-------------------+-------------------------------+-------------------+
                    |                               |
                    v                               v
+---------------------------------------+  +----------------------------+
|  3. Plugin Layer (Optional, Isolated) |  | 4. Observability Layer     |
|     - Single-Compressor Coordinator   |  |    - Universal TokenLedger |
|     - ToolResultRetention / Recovery  |  |    - CostTracker           |
|     - External Optimizers (Circuit    |  |    - CacheTracker          |
|       Breaker: Headroom/RTK/CC/LLML)  |  |    - AuditLog              |
|     - StateProvider (Noop / Companion)|  +----------------------------+
+-------------------+-------------------+
                    |
                    v
+-----------------------------------------------------------------------+
|  5. Provider Layer                                                    |
|     DeepSeek | OpenAI | Anthropic | Gemini | Local LLM | LiteLLM      |
+-----------------------------------------------------------------------+
```

---

## 二、两种运行模式（Embedded vs Proxy）

### 1. Embedded Mode（嵌入式库模式）
- **适用场景**：自定义 Node.js / Python Agent、LangGraph 节点、拥有自有记忆与循环控制的 Agent 运行时。
- **优势**：拥有**完整生命周期控制权**——可在发起请求前运行 `beforeWake()`（Opt-4）、在构史阶段运行 `prepareContext()`（Opt-1/Opt-3/ContextSelector）、在工具环内运行 `guardStep()`（Opt-5）。
- **核心入口**：`createOptimizer(config)` 返回统一的 Middleware 实例。

### 2. Proxy Mode（本地 HTTP 透明代理模式）
- **适用场景**：Claude Code、OpenClaw、Codex、现有 OpenAI/Anthropic SDK 应用（仅修改 `BASE_URL` 零代码侵入）。
- **协议端点**：
  - `POST /v1/chat/completions`（OpenAI / DeepSeek / LiteLLM 兼容）
  - `POST /v1/messages`（Anthropic Messages API 兼容）
  - `GET /health`、`GET /metrics`（成本与缓存统计）
- **能力边界说明（诚实声明）**：透明 Proxy 能完整执行 **Tool Governance、Tool Result Retention、Static Block Dedup（基于 header/marker）、Cache Economics 与 Cost Ledger**；但**主动唤醒拦截（Opt-4）与宿主机记忆沉淀（Auto-Flush）** 需要宿主配合调用控制 API 或 Webhook Hook，纯 HTTP 代理无法凭空预测宿主内部定时器意图。

---

## 三、核心接口契约（APIs）

### 1. Adapter API (`AgentAdapter`)
所有 Agent 运行时通过统一契约接入核心引擎：

```ts
export interface OptimizationContext {
  agentId: string;
  sessionId: string;
  conversationKey: string;
  provider: 'openai' | 'anthropic' | 'deepseek' | 'gemini' | 'local' | 'litellm' | string;
  model: string;
  turn?: number;
  messages: Array<Record<string, unknown>>;
  tools?: Array<Record<string, unknown>>;
  staticBlocks?: Record<string, string>;
  metadata?: Record<string, unknown>;
}

export interface AgentAdapter {
  readonly name: string;
  onWakeCheck?(trigger: WakeTriggerEvent): Promise<WakeDecision>;
  beforeRequest(ctx: OptimizationContext): Promise<OptimizedRequest>;
  onToolResult?(toolCall: ToolCallInfo, rawResult: unknown): Promise<ManagedToolResult>;
  afterResponse(ctx: OptimizationContext, response: NormalizedModelResponse): Promise<void>;
  onSessionRotate?(rotationCtx: RotationContext): Promise<RotationOutcome>;
}
```

### 2. Plugin API (`CompressionPlugin` & Single-Compressor Coordinator)
**防重复压缩硬性约束**：
- 同一内容片段（以 `contentHash` + `stage` 追踪）在一个请求周期内**默认最多只允许经过一个有损压缩器**。
- 当管道中同时注册了 `HeadroomAdapter`、`context-compress` 或 `LLMLingua2` 时，**Single-Compressor Coordinator** 按内容类型路由优先级（例如：`structured_json -> Headroom`，`cli_log -> RTK`，`unstructured_rag -> LLMLingua`，且对同一文本块打上 `compressedBy` 标记，禁止二次压缩）。
- 所有插件必须实现**熔断与安全回退（Circuit Breaker + Quality/Cost Gate）**：服务不可达、超时或 `predictedCostAfter > baselineCost` 时，立即返回原文 `originalContent`。

```ts
export interface CompressionPlugin {
  readonly name: string;
  readonly supportedContentTypes: Array<'tool_output' | 'rag_chunk' | 'history' | 'cli_log'>;
  isAvailable(): Promise<boolean>;
  compress(input: {
    content: string;
    contentType: string;
    budgetTokens?: number;
    preservePrefix?: boolean;
  }): Promise<{
    ok: boolean;
    content: string;
    compressedBy?: string;
    originalRefId?: string;
    qualityScore?: number;
    fallbackReason?: string;
  }>;
}
```

### 3. State Provider API (`StateProvider`)
通用核心绝不强依赖任何伴侣人格、情绪值或个人记忆文件：

```ts
export interface StateProvider {
  readonly name: string;
  getContextSignals(scope: { conversationKey: string; now: number }): Promise<{
    promptHints?: string[];
    priorityBoostById?: Record<string, number>;
    invocationBias?: number; // clamped, e.g. [-0.05, 0.05]
  }>;
  onBeforeSessionRotate?(handoffPayload: {
    conversationKey: string;
    fromSessionId: string;
    recentMessages: Array<unknown>;
  }): Promise<{ flushed: boolean; verificationToken?: string }>;
  onRecordsSelected?(records: Array<unknown>, scope: { now: number }): Promise<void>;
}
```
- **默认实现**：`NoopStateProvider`（返回空信号与 `flushed: true`）。
- **参考示例**：`CompanionStateProvider`（可选封装原有 `emotion-state.js` 与 `memory-reconsolidation.js`）。

---

## 四、仓库目标目录映射

为保持对原有 `Opt-1 ~ Opt-5` 导入路径的向后兼容，迁移采取**“核心分层重整 + 根 `src/*.js` 兼容重导出”**策略：

```text
src/
├── core/
│   ├── model-prices.js            # 补齐并通用化的多厂商价目表（含缓存读写倍率）
│   ├── cache-economics.js         # Cache-Aware Cost Model & Net Savings 引擎
│   ├── session-lifecycle.js       # Opt-1 演进：7 步事务化无损轮转
│   ├── tool-governance.js         # Opt-2 演进：场景化 Schema 裁剪与前缀稳定性检查
│   ├── static-context-dedup.js    # Opt-3 演进：通用静态块与动态子块指纹去重
│   ├── invocation-controller.js   # Opt-4 演进：优先级旁路 + 防抖 + 指数退避门控
│   ├── turn-controller.js         # Opt-5 演进：通用工具循环止血与副作用幂等
│   ├── tool-output-retention.js   # 工具输出本地保留、摘要句柄与按需恢复
│   ├── context-selector.js        # 通用上下文选择与 Fail-Closed Scope ACL
│   ├── token-budget.js            # 动态 Scope 预算与双阈值熔断
│   └── optimizer.js               # UniversalAgentOptimizer 统一编排器
├── adapters/
│   ├── base.js                    # AgentAdapter 基类与协议归一化
│   ├── openai-compatible.js
│   ├── anthropic.js
│   ├── mcp.js
│   ├── langgraph.js
│   └── custom-agent.js
├── plugins/
│   ├── compression.js             # Single-Compressor Coordinator + Quality Gate
│   ├── state-provider.js          # StateProvider 接口 + Noop + Companion 示例
│   └── external-optimizer.js      # Headroom / context-compress / RTK 外部适配器（含熔断回退）
├── observability/
│   ├── token-ledger.js
│   ├── cost-tracker.js
│   ├── cache-tracker.js
│   └── audit-log.js
├── proxy/
│   └── server.js                  # 零依赖本地 HTTP 透明代理（OpenAI / Anthropic）
└── (legacy root files: session-rotation.js, token-ledger.js, ... 保持向后兼容)
```
