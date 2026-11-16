[English](./README.md) | [简体中文](./README.zh-CN.md)

# universal-agent-optimizer-dsh

面向 [Universal Agent Optimizer](../../README.zh-CN.md) 的 DSH（DeepSeek Harness）Cordis Bundle 适配包。

## 本包提供的内容

- 指向 `./cordis.patch.yml` 的 `dsh.bundle.patch` 清单声明
- `engines.dsh` 兼容范围声明（`>=0.2.1-rc.2 <0.3.0-0`）
- Cordis 插件入口（`name`、`inject`、`apply`），封装 `UniversalAgentOptimizer` 并提供 `ctx.uao` 服务及 `dispose` 生命周期清理

## 安装到 DSH Profile

> **重要提示：** 请先在一次性测试 Profile 中验证，不要在未备份的情况下直接修改生产 Profile。

发布到 npm 后（或通过本地 tarball 安装）：

```bash
dsh plugin --profile uao-test add universal-agent-optimizer-dsh
dsh --profile uao-test --dump-config
```

卸载：

```bash
dsh plugin --profile uao-test remove universal-agent-optimizer-dsh
```

本地 tarball / 开发环境安装与验证步骤请见 [docs/INSTALL.zh-CN.md](../../docs/INSTALL.zh-CN.md)。
