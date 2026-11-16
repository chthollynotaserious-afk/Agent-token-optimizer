[English](./README.md) | [简体中文](./README.zh-CN.md)

# universal-agent-optimizer-dsh

DSH (DeepSeek Harness) Cordis bundle adapter for [Universal Agent Optimizer](../../README.md).

## What this package provides

- `dsh.bundle.patch` manifest pointing to `./cordis.patch.yml`
- `engines.dsh` compatibility declaration (`>=0.2.1-rc.2 <0.3.0-0`)
- Cordis plugin entry (`name`, `inject`, `apply`) that wraps `UniversalAgentOptimizer` and provides `ctx.uao` with lifecycle cleanup on `dispose`

## Installation into a DSH profile

> **Important:** Always test in a disposable profile first. Never modify your active production profile without backing it up.

When published to npm (or installed from a local tarball):

```bash
dsh plugin --profile uao-test add universal-agent-optimizer-dsh
dsh --profile uao-test --dump-config
```

To remove:

```bash
dsh plugin --profile uao-test remove universal-agent-optimizer-dsh
```

See [docs/INSTALL.md](../../docs/INSTALL.md) for local tarball / development installation and verification steps.
