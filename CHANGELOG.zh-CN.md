[English](CHANGELOG.md) | [简体中文](CHANGELOG.zh-CN.md)

# 更新日志

本文档记录 **Universal Agent Optimizer**（原 `本人 Agent 优化仓库 (v1)`）的所有重要变更。

## [2.0.0-alpha.2] - 2026-11-14 (`feature/p2-5-cli-types-sdk`)

### 新增与改进
- **CLI 命令行入口（`bin/uao.js`）**：新增 `uao proxy`、`uao benchmark`、`uao inspect-ledger`、`--help` 与 `--version`，通过 `package.json` 的 `"bin"` 暴露。
- **完整 TypeScript 类型声明（`types/index.d.ts`）**：完整覆盖 `src/index.js` 所有导出项，并在 `package.json` 的 `"types"` 与 `"exports['.'].types"` 暴露。
- **Python 轻量代理客户端（`python/uao_client.py`、`python/README.zh-CN.md`）**：基于 Python 3.9+ 标准库的零依赖客户端，支持 `/v1/chat/completions`、`/v1/messages`、`/health`、`/metrics`，并提供 OpenAI / LangGraph 接入示例。
- **API 易用性与双语文档**：新增 `UniversalAgentOptimizer.optimizeRequest()`、为 `createProxyServer()` 提供默认 Optimizer 构造、`package.json` 新增 `"files"` 白名单支持干净 `npm pack` 安装，以及全仓库所有 `.md` 文档的双语化（中英文对照与切换链接）。
- **验证测试**：新增 `tests/unit/cli-and-types.test.mjs` 与 `tests/integration/python-client.test.mjs`。

## [2.0.0-alpha.1] - 2026-11-14 (`feature/universal-agent-optimizer`，已合并至 `main`)

### 新增内容
- **架构与调研文档**：新增 `COMPETITOR_AUDIT`、`ARCHITECTURE_GAP_ANALYSIS`、`DIFFERENTIATION`、`ARCHITECTURE`、`BENCHMARK` 与 `ROADMAP`。
- **修复缺失价格表**：新增 `src/core/model-prices.js`（及 `src/model-prices.js` 兼容垫片），支持 DeepSeek、OpenAI、Anthropic（缓存读写分级）、Google Gemini 与本地模型及 `LEGACY_CNY_PRICE_TABLE`。
- **缓存感知成本模型（`src/core/cache-economics.js`）**：核算 `Net Savings = Baseline Cost - (Optimized API Cost + Overhead + Cache Rebuild Penalty)`，并显式区分 `observed` 与 `estimated` 口径。
- **通用框架 Adapter（`src/adapters/*`）**：新增 `BaseAgentAdapter`、`OpenAICompatibleAdapter`、`AnthropicAdapter`、`CustomAgentAdapter`、`MCPToolAdapter` 与 `LangGraphAdapter`。
- **核心差异化引擎**：
  - `src/core/session-lifecycle.js`：7 步事务性会话轮转（含 async flush 校验、Handoff、恢复验证与自动回滚）。
  - `src/core/invocation-controller.js`：唤醒事件去重、冷却/指数退避、预算门控与高优先级紧急直通旁路。
  - `src/core/tool-governance.js`：按场景/角色裁剪 Tool Schema、死工具清理与 Schema 抖动检测。
  - `src/core/tool-output-retention.js`：零依赖无损工具输出保留与按行号/关键词召回。
  - `src/core/static-context-dedup.js` & `src/core/context-selector.js`：去领域化静态上下文去重与多租户 Fail-Closed Scope ACL。
- **插件与本地 Proxy**：
  - `src/plugins/state-provider.js`：可选 `StateProvider` 接口（默认 `NoopStateProvider` + `CompanionStateProvider` 参考实现）。
  - `src/plugins/compression.js` & `src/plugins/external-optimizer.js`：Single-Compressor 协调器（含质量/成本门控、熔断器及 Headroom / context-compress / RTK 安全回退适配器）。
  - `src/proxy/server.js`：零依赖本地 HTTP 透明代理（`/v1/chat/completions`、`/v1/messages`、`/health`、`/metrics`）。
- **测试与模拟 Benchmark**：新增单元/集成/历史回归测试套件（`tests/`）、10 场景零费用模拟 Benchmark（`tests/benchmark/run-benchmark.mjs`）以及 GitHub Actions CI（`.github/workflows/ci.yml`）。

### 向后兼容性
- 所有 v1 根目录旧模块（`src/session-rotation.js`、`src/static-context-dedup.js`、`src/token-ledger.js`、`src/proactive-gate.js`、`src/turn-guard.js`、`src/context-selector.js` 等）均完整保留，并由 `tests/regression/legacy-compat.test.mjs` 持续验证。
