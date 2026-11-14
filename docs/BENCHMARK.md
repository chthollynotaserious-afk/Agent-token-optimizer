# Universal Optimizer Benchmark 设计规范

## 一、核心原则与反作弊红线

1. **禁止只汇报“Token 压缩率”**：必须同步汇报 `Total API Cost`、`Cache Hit/Miss`、`Task Success Rate` 与 `Regression Rate`。
2. **严格隔离数据口径**：
   - `empirical`（真实 API 实测）：真实发送请求至 Provider 并读取实际计费响应头/Usage。
   - `simulated`（确定性模拟环境）：使用统一 Tokenizer/字符估算规则 + 模拟 Agent 状态机 + 真实价目表公式进行离线可复现回放。
   - `theoretical`（理论估算）：基于已知公式的外推预测。
   - **严禁将 `simulated` 或 `theoretical` 标成 `empirical`；未经真实安装并运行测试的第三方工具不得汇报其“实测得分”。**
3. **控制变量铁律**：同一对比组内必须保证 **相同模型 ID、相同任务集、相同工具集、相同模型超参数（`temperature`/`max_tokens`）、相同单价口径（同一份 `model-prices.js` 版本）**。

---

## 二、十大标准测试场景

| 编号 | 场景名称 | 核心模拟特征 | 重点检验指标 |
|---|---|---|---|
| **S1** | 普通多轮聊天 | 8–12 轮短输入，低工具调用 | Optimizer Overhead、Prefix 稳定性、基线零退化 |
| **S2** | 长期连续对话 | 60+ 轮对话，含重复静态规则与上下文增长 | Session Rotation vs Compaction 的总成本与雪崩次数 |
| **S3** | 多轮工具调用 | 单回合 6–15 步工具续跳（含失败重试与死循环诱发） | Turn Guard 止血成功率、无效续跳削减率 |
| **S4** | 大型工具输出 | 单次工具返回 20KB–100KB JSON / 日志 / 文件内容 | Retention 压缩比、On-Demand Recovery 准确率 |
| **S5** | 长时间 Coding Agent | 读文件 → 改代码 → 跑测试 → 修 Bug 循环 30+ 步 | Task Success Rate、Cache Hit Rate、Net Savings |
| **S6** | 多 Agent 协作 | Coordinator + 2 Worker（共享指令 + 私有上下文） | Scope ACL 零越权率、跨 Agent 重复注入消除 |
| **S7** | 主动唤醒巡检 | 50 次定时触发（40 次空闲静默 + 5 次普通跟进 + 5 次紧急用户事件） | 零产出唤醒拦截率、**紧急事件 0% 误拦截率** |
| **S8** | 会话轮转与恢复 | 到达轮转上限后立即发起追问（代词指代 + 远期记忆回溯） | Context Recovery 完整性、事务失败回滚成功率 |
| **S9** | 记忆检索与权限隔离 | 多租户/多群聊混合记忆池 + 敏感条目 + 过期条目 | Fail-Closed 拦截率（100%）、相关记忆召回率 |
| **S10** | 多模型混合调用 | 主对话用旗舰/主力模型，沉淀与轻量判别路由至便宜模型 | 混合模型综合 Net Savings、质量一致性 |

---

## 三、对照组定义

| 对照组 | 说明 | 测试状态约定 |
|---|---|---|
| **Baseline（原始 Agent）** | 无任何上下文裁剪、无轮转、全量注入工具 Schema、无唤醒门控 | 本地模拟框架可全量跑通（`simulated`） |
| **Agent + Universal Optimizer（Core）** | 启用 Opt-1~5 演进核心 + Retention + Cache Economics | 本地模拟框架全量跑通（`simulated`）；真实模型需用户批准额度后执行（`empirical`） |
| **Agent + Headroom** | 通过 `HeadroomPlugin` 接入（需本机部署 Headroom 服务/SDK） | 若未安装则仅记录接口适配器与熔断回退测试（不伪造性能数字） |
| **Agent + ContextPilot** | 通过参考对照配置（需本机安装 `contextpilot-ai`） | 同上 |
| **Agent + context-compress** | 通过 MCP Server 挂载（需本机安装 `context-compress`） | 同上 |
| **Agent + 组合方案** | Universal Optimizer（Lifecycle + Invocation + Schema + Cache Gate）+ 外部压缩插件 | 检验 Single-Compressor Guard 无重复压缩及净成本协同 |

---

## 四、核心指标与计算口径

| 指标 | 定义 / 公式 | 采集来源 |
|---|---|---|
| **Total API Cost** | $\sum (\text{Miss}\cdot P_{\text{miss}} + \text{Hit}\cdot P_{\text{hit}} + \text{Write}\cdot P_{\text{write}} + \text{Out}\cdot P_{\text{out}})$ | `TokenLedger` + `model-prices.js` |
| **Input / Output Tokens** | 分桶累计 `cacheMiss`、`cacheHit`、`cacheWrite`、`output`、`reasoning` | 模型响应 / 模拟器精确计数 |
| **Cache Hit / Miss Ratio** | $\text{cacheHit} / (\text{cacheHit} + \text{cacheMiss} + \text{cacheWrite})$ | 同上 |
| **Net Savings** | $\text{Baseline Cost} - (\text{Optimized API Cost} + \text{Optimizer Overhead Cost})$ | `CacheEconomicsEngine` |
| **Task Success Rate** | 任务关键断言通过数 / 总任务数（如文件修改正确、问题答对、工具参数无误） | 场景断言器（Deterministic Verifier） |
| **Context Recovery Rate** | 轮转或输出压缩后仍能正确回答关联细节的比例 | S4 / S8 专项探针 |
| **Latency & Overhead** | 端到端耗时 + 中间件本地处理耗时（ms） | `performance.now()` |
| **Regression Rate** | `Baseline 通过但 Optimized 失败` 的任务占比（必须 $\le$ 设定阈值，如 `0%`~`2%`） | 配对比较器 |

---

## 五、原始数据留存格式

每次 Benchmark 运行输出两份不可篡改记录（JSONL + Markdown 汇总）：
- `dataSourceMode`: `'simulated' | 'empirical'`
- `priceTableVersion`、`model`、`scenarioId`、`arm`（对照组名）
- `rawCalls[]`：每一步的原始 `usage`、`latencyMs`、`overheadMs`、`gateDecision`、`assertionsPassed`
- 任何汇总报告必须附上运行时间戳、Git Commit Hash 与环境变量说明。
