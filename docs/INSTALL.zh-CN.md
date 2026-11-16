[English](./INSTALL.md) | [简体中文](./INSTALL.zh-CN.md)

# 安装与诊断指南

## 1. 包发布状态重要说明

- `universal-agent-optimizer`（`2.0.0-alpha.2`）与 `universal-agent-optimizer-dsh`（`2.0.0-alpha.2`）**尚未发布**到公共 npm registry（`npm view universal-agent-optimizer` 返回 `E404`）。
- **请勿执行 `npx uao ...`**：npm 上名为 `uao` 的包是另一个无关的 `0.0.0` 包。
- 在正式发布到 npm 之前，请通过本地仓库或打包 `.tgz` 安装；发布后请使用显式指定包名的调用方式：

```bash
npm exec --yes --package=universal-agent-optimizer -- uao --help
```

## 2. 本地 / 开发环境安装（当前预发布可用路径）

```bash
git clone https://github.com/chthollynotaserious-afk/Agent-token-optimizer.git
cd Agent-token-optimizer
node bin/uao.js --help
```

或从本地目录全局安装：

```bash
npm install --global .
uao --help
```

## 3. 交互式安装向导（`uao setup`）

运行交互式安装向导（或使用 `--yes` 进行非交互式安装）：

```bash
# 本地 HTTP 代理模式（默认安全监听地址：127.0.0.1）
uao setup --mode proxy --upstream https://api.openai.com --yes

# 仅预览变更，不写入任何文件
uao setup --mode proxy --upstream https://api.openai.com --dry-run
```

安全默认值：
- 代理默认绑定 `127.0.0.1`（绝不默认绑定 `0.0.0.0`）。
- API Key 绝不写入配置文件，仅通过环境变量读取（`OPENAI_API_KEY`、`ANTHROPIC_API_KEY`、`DEEPSEEK_API_KEY`）。
- 修改任何已有配置文件前都会先创建备份（`*.uao-backup-*`）。

## 4. DSH（DeepSeek Harness）Bundle 安装

请务必先在一次性测试 Profile 中验证（绝不直接修改正在使用的生产 Profile）：

```bash
# 1. 打包核心包与 DSH Bundle
npm pack --pack-destination /tmp/uao-pkg
npm pack ./packages/dsh-bundle --pack-destination /tmp/uao-pkg

# 2. 在一次性 Profile（如 uao-test）中通过 dsh plugin add 安装
dsh plugin --profile uao-test add /tmp/uao-pkg/universal-agent-optimizer-dsh-2.0.0-alpha.2.tgz

# 3. 验证 Bundle 登记与 Cordis Patch 生效情况
dsh --profile uao-test --dump-config
```

预发布本地测试说明：由于 `universal-agent-optimizer` 尚未发布到 npm，在测试 Profile 中执行 `dsh plugin add` 前，需在该测试 Profile 的 `pnpm-workspace.yaml` 中添加 `overrides` 将 `universal-agent-optimizer` 指向本地打包的核心 `.tgz`。

## 5. 环境诊断（`uao doctor`）

```bash
# 人类可读双语输出（--lang auto|en|zh-CN）
uao doctor --lang zh-CN

# 机器可读 JSON 输出（Key 与错误码语言无关）
uao doctor --json

# 检查指定 DSH Profile
uao doctor --profile uao-test
```

可能的总体状态：`verified`、`partially_configured`、`unsupported`、`not_installed`。

## 6. 安全卸载（`uao uninstall`）

```bash
# 预览卸载内容
uao uninstall --dry-run

# 移除 UAO 创建的配置与/或 DSH Bundle（默认保留 Ledger 与用户自建文件）
uao uninstall --profile uao-test --yes

# 如需一并清理 UAO 生成的 Ledger/备份文件，必须显式传入二次确认参数
uao uninstall --purge-data --confirm-purge --yes
```
