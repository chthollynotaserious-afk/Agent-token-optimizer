[English](SECURITY.md) | [简体中文](SECURITY.zh-CN.md)

# 安全策略（Security Policy）

## 支持的版本

| 版本 | 支持状态 | 说明 |
| --- | --- | --- |
| `2.0.0-alpha.x`（Universal Agent Optimizer） | :white_check_mark: | 当前活跃开发版本（`main`） |
| `1.x`（旧版 `Opt-1 ~ Opt-5` 模块） | :white_check_mark: | 保持兼容垫片与安全回归修复 |
| `< 1.0` | :x: | 已停止维护的早期快照版本 |

## 安全边界与核心设计保障

- **零密钥持久化**：本库与 CLI 不收集、不落盘、不上报任何模型 API Key；在本地透明代理模式（`createProxyServer`）下，鉴权请求头仅在单次转发周期内透传给上游。
- **Fail-Closed 作用域隔离**：多租户上下文筛选（`selectUniversalContext` / `canAccessScope`）在缺失租户或作用域元数据时默认拒绝，并严格遵守脱敏回调，绝不回退泄露原文。
- **外部压缩插件熔断隔离**：第三方可选插件（`HeadroomPlugin`、`ContextCompressPlugin`、`RTKPlugin`）均受熔断器保护，异常或超时即安全回退原文。

## 漏洞反馈方式

如发现安全漏洞（如 Scope ACL 越权绕过、账本/审计日志敏感字段泄漏、HTTP Proxy 请求走私等）：

1. **请勿在公开 Issue 中**直接贴出真实 API Key、攻击载荷或私人会话日志。
2. 请通过本仓库 GitHub 页面的 **Security -> Advisories -> Report a vulnerability** 提交私密报告。
3. 请附上受影响文件路径、使用合成样本的复现步骤及影响评估。

我们通常会在 **72 小时内**响应并协调修复，修复完成后再公开披露细节。
