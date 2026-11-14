# Universal Agent Optimizer 演进路线图（Roadmap）

- **当前分支**：`feature/universal-agent-optimizer`
- **基线版本**：`1.0.0`（Denia 生产提取参考版）
- **演进原则**：先补齐基础设施与可测试性（P0），再落地核心差异化闭环（P1），最后扩展外部生态与 Proxy/SDK（P2）；全程保持旧 `Opt-1 ~ Opt-5` API 向后兼容。

---

## P0：基础设施与可验证基线（本阶段核心交付）

| 编号 | 任务项 | 核心交付内容 | 验收标准 | 预估难度 | 依赖关系 |
|---|---|---|---|---|---|
| **P0-1** | 补齐价格表与通用 Token Ledger | 新增 `src/core/model-prices.js`（并兼容 `src/model-prices.js`）；新增 `src/observability/token-ledger.js`、`cost-tracker.js`、`cache-tracker.js`、`audit-log.js` | 原有 `token-ledger.js` 与 `tool-cost-attribution.js` 可无错导入运行；支持 OpenAI/Anthropic/DeepSeek/Gemini 用量格式归一化 | 低 | 无 |
| **P0-2** | Cache-Aware Cost Model | `src/core/cache-economics.js`：区分 `observed` 与 `estimated`，计算 Net Savings、压缩盈亏平衡点与前缀缓存击穿惩罚 | 单测覆盖缓存命中/未命中价差与净负收益回退判断 | 中 | P0-1 |
| **P0-3** | Universal Adapter API 与 Core Orchestrator | `src/adapters/base.js`（及 `openai-compatible` / `anthropic` / `custom-agent` 等）；`src/core/optimizer.js`；`src/core/tool-governance.js` | 至少 1 个（目标多个）模拟 Agent 通过 Adapter 接入并完成完整请求/工具/响应周期 | 中 | P0-1, P0-2 |
| **P0-4** | 原有 Opt-1~5 全面兼容性测试 | `tests/regression/legacy-compat.test.mjs` 替换伪测试 `test_cost_calc.mjs`，覆盖全部旧模块导入与核心语义 | 所有旧导出签名与行为通过测试，零回归 | 中 | P0-1 |
| **P0-5** | Quality Regression Benchmark 套件 | `tests/benchmark/run-benchmark.mjs` + 10 场景模拟运行器（零真实 API 费用） | 输出 Baseline vs Universal Optimizer 对照指标，清晰标记 `simulated` 口径 | 中 | P0-3 |

---

## P1：差异化核心能力深化

| 编号 | 任务项 | 核心交付内容 | 验收标准 | 预估难度 | 依赖关系 |
|---|---|---|---|---|---|
| **P1-1** | 事务化 Session Lifecycle Controller | `src/core/session-lifecycle.js`：7 步安全轮转状态机（加锁 → `await` 沉淀 → 校验持久化 → 保存 Handoff → 切新会话 → 恢复验证 → 失败回滚） | 注入异步沉淀失败与恢复失败故障用例，验证旧会话 100% 完整回滚 | 中-高 | P0-3 |
| **P1-2** | Autonomous Invocation Controller | `src/core/invocation-controller.js`：事件触发、去重合并、冷却退避、预算感知与**高优先级旁路通道** | 验证 50 次混杂唤醒中低价值空转被拦截，高优事件 0% 误拦截 | 中 | P0-3 |
| **P1-3** | Tool Result Retention & Recovery | `src/core/tool-output-retention.js`：本地原文保留存储、摘要句柄生成与行范围/关键词按需检索 | 大型 JSON/日志压缩后可通过 `retrieveToolResult()` 精确取回原文片段且哈希一致 | 中 | P0-3 |
| **P1-4** | 可选 State Provider Interface | `src/plugins/state-provider.js`：定义接口 + `NoopStateProvider` + `CompanionStateProvider`（封装原情绪/再巩固模块） | Core 在完全移除情绪/伴侣模块的情况下正常运行；挂载示例插件行为兼容 | 低-中 | P0-3 |
| **P1-5** | 通用 Context Selector 与 Scope ACL | 抽离 `qq`/`bili`/`pet` 硬编码，保留 Fail-Closed 多租户/作用域隔离模型 | 跨租户/跨作用域泄漏单测 100% 拦截 | 中 | P1-4 |

---

## P2：生态兼容与代理模式

| 编号 | 任务项 | 核心交付内容 | 验收标准 | 预估难度 | 依赖关系 |
|---|---|---|---|---|---|
| **P2-1** | Single-Compressor Guard + 第三方插件框架 | `src/plugins/compression.js`、`src/plugins/external-optimizer.js`（`HeadroomPlugin`、`ContextCompressPlugin`、`RTKPlugin` 接口与熔断器） | 禁止同一内容重复压缩；Mock 服务不可用或超时时 100% 回退原文 | 中 | P0-2, P1-3 |
| **P2-2** | Local Proxy Mode | `src/proxy/server.js`：零依赖 Node HTTP 代理（`/v1/chat/completions`、`/v1/messages`、`/metrics`） | 本地集成测试拦截标准请求并回写 Token Ledger | 中-高 | P0-3, P2-1 |
| **P2-3** | MCP & LangGraph 集成适配器 | `src/adapters/mcp.js`、`src/adapters/langgraph.js`（MCP 工具包装拦截 + LangGraph 节点/状态钩子） | 独立模拟测试验证工具结果保留与状态钩子调用 | 中 | P0-3, P1-3 |
| **P2-4** | 真实环境第三方对比 Benchmark（需用户批准预算后） | 在真实安装 Headroom / ContextPilot / context-compress 与批准的 API 预算下采集 `empirical` 数据 | 生成可审计的真实对照报告 | 高（外部依赖） | P0-5, P2-1 |
| **P2-5** | npm 包发布与 Python SDK 规划 | ESM 包导出 (`exports`)、TypeScript `.d.ts` 类型定义、CLI (`npx uao proxy`) 与 Python 轻量封装方案 | 干净环境 `npm pack` 安装验证通过 | 中 | P2-2 |
