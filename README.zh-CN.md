[English](README.md) | [简体中文](README.zh-CN.md)

# Universal Agent Optimizer

**面向长生命周期 AI Agent 的开源运行时优化中间件。**

> **当前状态：** `v2.0.0-alpha.2`（由 `本人 Agent 优化仓库 (v1)` 通用化演进而来）。
> 零第三方运行依赖的 Node.js（`>=20.0.0`）ESM 运行时 + 完整 TypeScript 类型声明（`types/index.d.ts`）+ 命令行工具（`uao`）+ 零依赖 Python HTTP 代理客户端（`python/uao_client.py`），并保持对所有 v1 旧版 `src/*.js` 模块的 100% 向后兼容。

Universal Agent Optimizer 致力于在不牺牲 Agent 任务成功率、不击穿 KV-Cache 前缀缓存、不绕过工具权限隔离、不在会话轮转时丢失关键记忆的前提下，降低有状态长程 Agent 的真实 API 费用、无效模型唤醒、工具膨胀与长会话上下文膨胀。

---

## 为什么还需要 Universal Agent Optimizer？

现有主流方案主要解决**无状态单轮 Prompt 压缩**或**网关路由计费**；而长程运行的 Agent 在成本与可靠性上往往死在另一组问题上：

| 维度 | 现有主流工具局限 | Universal Agent Optimizer 差异化能力 |
|---|---|---|
| **KV-Cache 成本经济学** | 只看单轮 Token 压缩，容易破坏静态前缀导致缓存重建反超省钱收益 | **缓存感知成本门控（`src/core/cache-economics.js`）**：精确核算 `Net Savings = Baseline - (Optimized + Overhead + Cache Rebuild Penalty)`，净收益为负时自动阻断改写。 |
| **长会话生命周期** | 直接清空或丢弃摘要，缺少持久化校验与回滚 | **7 步事务性安全轮转（`src/core/session-lifecycle.js`）**：加锁 → `await` 沉淀 → 持久化校验 → 生成 Handoff → 切换会话 → 恢复验证 → 任一步失败全量回滚。 |
| **自主唤醒成本** | 轮询/心跳盲目调用全价模型 | **自主唤醒控制器（`src/core/invocation-controller.js`）**：事件去重、冷却与指数退避、预算门控，同时保证 `urgent` / `user_direct` 高优事件**永不拦截直通**。 |
| **工具治理与输出留存** | 每轮全量下发几十个工具 Schema；大输出直接暴力截断 | **工具治理（`src/core/tool-governance.js`）与原文留存存储（`src/core/tool-output-retention.js`）**：按场景/角色裁剪、死工具与重复失败循环熔断、压缩日志并支持按行/关键词无损召回。 |
| **多租户与作用域隔离** | 上下文扁平混放，易跨会话越权泄漏 | **Fail-Closed Scope ACL（`src/core/context-selector.js`）**：严格按租户、作用域、私密等级执行默认拒绝隔离。 |
| **第三方压缩器协同** | 多个压缩工具叠加抢改同一个前缀 | **单压缩器协调器 + 熔断降级（`src/plugins/compression.js`、`src/plugins/external-optimizer.js`）**：统一协调 Headroom、`context-compress`、RTK，故障时安全回退原文。 |

更多研究审计与设计细节可查阅 [`docs/`](./docs/)：
- [竞品技术审计](./docs/COMPETITOR_AUDIT.zh-CN.md)
- [架构差距分析](./docs/ARCHITECTURE_GAP_ANALYSIS.zh-CN.md)
- [差异化定位文档](./docs/DIFFERENTIATION.zh-CN.md)
- [通用化系统架构](./docs/ARCHITECTURE.zh-CN.md)
- [Benchmark 设计规范](./docs/BENCHMARK.zh-CN.md)
- [演进路线图](./docs/ROADMAP.zh-CN.md)

---

## 成熟度与诚实边界声明

> [!IMPORTANT]
> **区分「本地已实测」「仅本地 Mock 验证」与「待开展真实外部联调」：**

- **已在本地环境完整实测验证（Node.js + Python 代理 + 包打包校验）：**
  - 核心引擎：`UniversalAgentOptimizer`、`cache-economics`、`model-prices`、`session-lifecycle`、`invocation-controller`、`tool-governance`、`static-context-dedup`、`tool-output-retention`、`context-selector`
  - 内置框架适配器：`BaseAgentAdapter`、`OpenAICompatibleAdapter`、`AnthropicAdapter`、`CustomAgentAdapter`、`MCPToolAdapter`、`LangGraphAdapter`
  - 可选状态接口与单压缩协调器：`NoopStateProvider`、`CompanionStateProvider`、`SingleCompressorCoordinator`
  - 可观测性与审计：`UniversalTokenLedger`、`CostTracker`、`CacheTracker`、`AuditLog`
  - 本地零依赖 HTTP 代理与 Python 客户端（`createProxyServer`、`python/uao_client.py`）对本地 HTTP 上游桩的端到端往返实测
  - CLI（`bin/uao.js`）、TypeScript 类型声明导出一致性（`types/index.d.ts`）、`npm pack` 打包产物安装验证，以及 v1 旧模块回归兼容测试
- **仅基于本地 Mock 验证（待真实外部环境联调）：**
  - 第三方插件适配器 `HeadroomPlugin`、`ContextCompressPlugin`、`RTKPlugin`（`src/plugins/external-optimizer.js`）：目前仅测试了本地 Mock HTTP/CLI 协议、熔断器开关与安全回退，尚未在 CI 中拉起真实外部服务联调。
  - 云端付费 LLM 实测对比：当前 Benchmark 均为 `simulated`（零真实 API 花费）；`empirical` 实证报告需后续接入真实可用 API 凭证后采集。
- **架构外置能力（不重复造轮子）：**
  - 多供应商 Key 池路由、商业账单结算网关（交给 LiteLLM 等 Gateway 层）。
  - 需要本地 GPU 推理的 Token 级模型打分压缩（如 LLMLingua）。

---

## 快速上手

### 1. CLI 命令行模式（`npx uao`）

```bash
# 启动本地透明 HTTP 代理（兼容 OpenAI / DeepSeek / Anthropic / Ollama 等）
npx uao proxy --upstream https://api.openai.com --port 8787 --provider openai

# 运行 10 场景零费用模拟 Benchmark
npx uao benchmark

# 查看 JSONL Token 账本统计
npx uao inspect-ledger ./data/ledger.jsonl
```

### 2. JS / TypeScript 嵌入式中间件模式

```js
import { UniversalAgentOptimizer } from 'universal-agent-optimizer';

const optimizer = new UniversalAgentOptimizer();

const result = await optimizer.optimizeRequest({
  model: 'deepseek-chat',
  sessionId: 'session-1',
  scene: 'coding',
  tools: [
    { name: 'read_file', description: 'Read file lines' },
    { name: 'billing_export', description: 'Export invoice' },
  ],
  messages: [
    { role: 'system', content: 'You are a concise coding assistant.' },
    { role: 'user', content: 'Inspect src/index.js for exports.' },
  ],
  invokeUpstream: async (preparedPayload) => {
    // 使用 preparedPayload.messages 与 preparedPayload.tools 调用你的模型客户端
    return {
      content: 'Done.',
      usage: { prompt_tokens: 1200, prompt_cache_hit_tokens: 900, completion_tokens: 45 },
    };
  },
});

console.log(result.telemetry);
```

### 3. 本地透明 HTTP 代理 + Python 客户端模式

```js
import { createProxyServer } from 'universal-agent-optimizer';

const proxy = createProxyServer({
  upstreamBaseUrl: 'https://api.openai.com', // 也可指向 DeepSeek / Anthropic / Ollama / vLLM
});

proxy.listen(8787, '127.0.0.1');
// 暴露路由：POST /v1/chat/completions | POST /v1/messages | GET /health | GET /metrics
```

Python 3.9+ 零依赖客户端及 OpenAI SDK / LangGraph 接入示例见 [python/README.zh-CN.md](./python/README.zh-CN.md) 与 [python/uao_client.py](./python/uao_client.py)。

### 4. 内置记忆提取持久化与自动挂载取回工具

- **内置记忆提取与存储（`UniversalMemoryStore`）**：会话轮转时（或手动调用 `optimizer.extractAndSaveMemory()`）自动提取偏好、决策、故障与会话归档并写入可选 JSONL（`memoryFile`），自动脱敏密钥并在召回时执行 Fail-Closed 作用域隔离；若宿主 Agent 已有自己的 LLM 总结器，也可通过 `memoryExtractor` 直接接入。
- **取回/召回工具自动注入与执行**：当出现大工具输出留存或已有历史记忆时，框架会自动将 `uao_retrieve_tool_output` 与 `uao_recall_memory` 工具 Schema 注入请求，并在 `optimizeRequest()`、`OpenAICompatibleAdapter.runWithTools()`、`AnthropicAdapter.runWithTools()`、`MCPToolAdapter.getBuiltinTools()` 及 `createProxyServer()` 代理中自动截获执行闭环。

---

## 仓库目录结构

```text
bin/
└── uao.js                           # CLI 入口（proxy / benchmark / inspect-ledger）
python/
├── uao_client.py                    # 零依赖 Python 3.9+ HTTP 代理客户端
└── README.md                        # Python / OpenAI SDK / LangGraph 接入指南
types/
└── index.d.ts                       # 与 src/index.js 导出完全对齐的 TypeScript 类型声明
src/
├── index.js                         # v2 Universal Agent Optimizer 主导出入口
├── model-prices.js                  # 兼容旧版 token-ledger 导入的垫片文件
├── core/
│   ├── optimizer.js                 # prepareRequest / afterResponse / optimizeRequest 主编排
│   ├── cache-economics.js           # 厂商缓存配置画像与净省钱成本门控
│   ├── model-prices.js              # 多厂商 USD 与旧版 CNY 费率表 + 用量归一化
│   ├── session-lifecycle.js         # 7 步事务性安全会话轮转与回滚状态机
│   ├── invocation-controller.js     # 事件去重、冷却退避、预算门控与紧急直通旁路
│   ├── tool-governance.js           # 场景/角色工具裁剪、Schema 哈希与死工具熔断
│   ├── tool-output-retention.js     # 大工具输出本地无损留存与按行/关键词召回
│   ├── memory-store.js              # 内置记忆提取、JSONL 持久化归档与隔离召回
│   ├── builtin-tools.js             # 自动挂载与执行的取回/记忆召回工具闭环
│   ├── static-context-dedup.js      # 领域无关的静态上下文指纹去重
│   └── context-selector.js          # 多租户 Fail-Closed Scope ACL 记忆/证据筛选
├── adapters/                        # OpenAI / Anthropic / Custom / MCP / LangGraph 适配器
├── plugins/                         # StateProvider、SingleCompressorCoordinator、外部优化器插件
├── observability/                   # TokenLedger、CostTracker、CacheTracker、AuditLog
├── proxy/server.js                  # 零依赖本地 HTTP 透明代理
└── *.js                             # 保留完整兼容性的 v1 旧版模块
tests/
├── unit/                            # 核心引擎、CLI 与类型覆盖率单元测试
├── integration/                     # 多框架模拟 Agent、HTTP 代理、Python 客户端与 Benchmark 集成测试
├── regression/                      # v1 旧模块兼容与回归测试
└── benchmark/run-benchmark.mjs      # 10 场景零费用模拟 Benchmark 运行器
scripts/                             # v1 原始验证脚本
docs/                                # 竞品审计、架构设计、Benchmark 规范与演进路线图
```

---

## 模拟 Benchmark 结果汇总（`S1`–`S10`）

> **口径说明：** 下表数据由 `npm run benchmark`（`node tests/benchmark/run-benchmark.mjs`）在 **SIMULATED 模式（零真实 API 消费）** 下运行测得，用于确定性验证成本核算模型、缓存击穿保护、唤醒拦截、工具输出留存与事务轮转逻辑；**不代表真实线上 API 实测账单**。

| 场景 | 模型 | 基线成本 | 优化后成本 | 净节省 | TaskOK | 回归率 | 额外开销 |
|---|---|---:|---:|---:|---:|---:|---:|
| S1: 常规多轮对话（10 轮） | `deepseek-chat` | \$0.00626 | \$0.00557 | 11.1% | 100% | 0% | 12.89ms |
| S2: 超长会话压缩与轮转（60 轮） | `deepseek-chat` | \$0.23480 | \$0.03602 | 84.7% | 100% | 0% | 5.69ms |
| S3: 多轮工具调用与循环熔断 | `gpt-4o-mini` | \$0.01122 | \$0.00285 | 74.6% | 100% | 0% | 1.87ms |
| S4: 大工具输出留存与精准召回 | `claude-sonnet-4` | \$0.06099 | \$0.01089 | 82.1% | 100% | 0% | 0.93ms |
| S5: 长程编程 Agent（30 步 / 80 工具） | `claude-sonnet-4` | \$0.19689 | \$0.17131 | 13.0% | 100% | 0% | 4.19ms |
| S6: 多 Agent 协同与 Scope ACL 隔离 | `gpt-4o-mini` | \$0.00324 | \$0.00162 | 50.0% | 100% | 0% | 0.48ms |
| S7: 自主唤醒节流（50 次触发 / 5 次紧急） | `deepseek-chat` | \$0.34190 | \$0.04103 | 88.0% | 100% | 0% | 0.45ms |
| S8: 会话轮转与恢复校验 | `deepseek-chat` | \$0.00335 | \$0.00051 | 84.6% | 100% | 0% | 0.17ms |
| S9: 跨作用域检索隔离 | `gpt-4o-mini` | \$0.00065 | \$0.00012 | 82.2% | 100% | 0% | 0.18ms |
| S10: 主/辅混合模型路由 | `claude-sonnet-4` | \$0.05100 | \$0.01959 | 61.6% | 100% | 0% | 0.03ms |

---

## 本地开发与测试

环境要求：**Node.js >= 20.0.0**（可选 **Python >= 3.9** 用于运行 Python 代理集成测试；无第三方包依赖）。

```bash
# 运行全部单元测试、集成测试与 v1 回归兼容测试
npm test

# 分类执行测试
npm run test:unit
npm run test:integration
npm run test:regression

# 运行 10 场景零费用模拟 Benchmark
npm run benchmark
```

---

## 开源协议

MIT
