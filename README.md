# Denia Token Optimizer — 高 KV Cache 命中率与低 Token 消耗核心模块（Opt-1 ~ Opt-5）

> 从 **Denia Cloud** 生产环境抽取的核心上下文工程与成本优化模块：在**不削弱人格、记忆、情绪与社交安全**的前提下，解决长会话前缀缓存击穿、静态规则重复入史、死工具 Schema 膨胀与无效唤醒空转问题。

---

## 一、为什么“高命中率”仍然会很贵？（实证痛点）

基于生产环境全链账本与 DSH Trace 实测（单日基线 **`¥18.87 / 天`**，均值 `144k` 输入 Token）：

1. **表面 96.46% 的缓存命中率掩盖了 53.4% 的费用来源**：DeepSeek `cacheMiss` 单价是 `cacheHit` 的 **50 倍**，仅占 **3.54%** 的未命中 Token 贡献了全天 **53.4%** 的费用。
2. **每轮重复塞入静态规则会引发“复利滚雪球”**：每次唤醒把 `~8.4K–16.5K` 字符的固定规则写进 `user/message`，不仅当轮首跳 `cacheMiss`，还会永久留在历史里在后续所有轮次重复计费。
3. **长会话撞线 Compaction 打穿全前缀缓存**：单会话跑到 90+ 轮、每 3–7 轮触发一次 `compaction/summary`（压缩自身缓存命中率仅 `14.8%`），并直接改写前缀导致后续 `130k–197k` 上下文全量未命中。
4. **124 个全局工具 Schema（`~26.7k` Tokens）**：包含 100% 被权限拦截的死工具 `mcp-onebot-min`（19 工具 / `6,827` 字符/步），并在无文件权限的群聊中全量挂载。

---

## 二、Opt-1 ~ Opt-5 优化体系与核心模块

| 优化代号 | 核心机制 | 关键代码与脚本 | 实测 / 设计收益 |
| :--- | :--- | :--- | :--- |
| **Opt-1** | **无损会话轮转 + 原生滑窗交接**<br>私聊 30 轮 / 群聊 25 轮 / 闲置 >4h 且轮数 >=4 自动新建干净会话，首轮仅注入 <=6 条原生对话切片（不写情绪数值） | `src/session-rotation.js`（已从 `bridge.js` 抽离）<br>`scripts/rollback_opt1.mjs`（双回滚点） | 把日均 `14` 次高价 Compaction 压至近 0（预估省 `¥7.2–¥9.2/天`） |
| **Opt-2** | **死工具清理与场景 Schema 隔离**<br>下线 `mcp-onebot-min`（19 死工具），按主人 / 群聊 / 后台任务隔离工具表，并追踪工具调用成本 | `src/tool-cost-attribution.js`<br>`scripts/remote-opt2-remove-onebot-min.mjs` | 每步直降 `6,827` 字符并消除报错（预估省 `¥1.6–¥2.2/天`） |
| **Opt-3** | **静态上下文去重 + KV Cache 前缀保护**<br>会话内静态块只注一次，跨轮去重（私聊 25 轮 / 群聊 12 轮刷新）；严守 `thresholdRatio: 0.22` | `src/static-context-dedup.js`（已从 `bridge.js` 抽离）<br>`src/prompt-fingerprint.js`<br>`scripts/test-opt3-expand.mjs`<br>`scripts/phase0_static_context_verify.mjs` | 实测稳定净省 **`7,718` 字符/轮**，`base` 从 `14,788` 降至 `6,950` |
| **Opt-4** | **主动唤醒轻量前置门控**<br>在唤醒 LLM 前先跑本地评分门控与冷却检查，拦截闲群零出站空转 | `src/proactive-gate.js`<br>`src/proactive-policy.js`<br>`src/proactive-config.js` | 砍掉 54% 零出站冷唤醒（预估省 `¥1.4–¥1.9/天`） |
| **Opt-5** | **回合收尾与控制步节流**<br>合并多气泡发送、控制动作折叠、去除多余强制等待回合 | `src/turn-end-policy.js`<br>`src/turn-guard.js`<br>`src/v2-wait.js`<br>`src/priority-budget.js` | 削减串行 `tool-continuation` 续跳（预估省 `¥1.8–¥2.5/天`） |

### 统一上下文选择与预算基建（`src/`）

- `src/context-selector.js`：唯一真相源收拢，`selectContext()` 统一预算与去重、槽位优先（`pinned` / `firstMet`）、情绪一致性加权（`memory-reconsolidation.js`）以及 **Fail-Closed 权限后置校验 `visible(record, requestCtx)`**。
- `src/token-budget.js` & `src/token-guard.js`：分槽位 Token 预算分配与静默超限防护（对应 `scripts/test-a2-silent-overbudget.mjs`）。
- `src/token-ledger.js`：调用级 Token 账本与 `/cost` 全链费用统计（对应 `scripts/test_cost_calc.mjs`、`scripts/test-cost-summary.mjs`）。

---

## 三、目录结构

```text
.
├── package.json
├── README.md
├── src/                        # Opt-1~5 核心引擎、预算、门控与归因模块
├── scripts/                    # 单元测试、验证脚本、Opt-1 回滚与 Opt-2 清理脚本
│   └── patches/                # Opt-1~5 生产补丁脚本（apply_opt1_and_cost / apply_opt1_hardening / apply_opt45_patches / apply_static_context_dedup / patch-dsh-session-guard 等）
└── docs/
    ├── phase0/                 # KV Cache 前缀验证与静态上下文审计报告
    └── phase1/                 # 全链 Token 审计与 Opt-1~6 优化方案总报告
```

---

## 四、快速验证（本地运行单元测试）

要求 Node.js 20+（零第三方依赖，纯原生 `node:test`）：

```bash
npm test
```

或单独运行上下文选择器与成本计算测试：

```bash
node --test scripts/test-context-selector.mjs scripts/test_cost_calc.mjs
```

---

## 五、核心设计红线

1. **绝不放宽 `compaction-basic` 的 `thresholdRatio: 0.22`**：避免日常调用长期背负超大上下文，防止 20 分钟缓存 TTL 超时后的冷未命中惩罚。
2. **保留 `memory-card` 与 `memory-book`**：两者合计不足总输入的 `0.2%`，却是替代超长流水账历史、支撑无损轮转的核心支柱。
3. **跨轮交接只给原生对话切片，不写情绪数值**：避免模型把 `valence/arousal` 数值当台词注解去演。
