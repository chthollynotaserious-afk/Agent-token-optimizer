[English](./INSTALL.md) | [简体中文](./INSTALL.zh-CN.md)

# Installation & Diagnostics Guide

## 1. Important Package Status Note

- `universal-agent-optimizer` (`2.0.0-alpha.2`) and `universal-agent-optimizer-dsh` (`2.0.0-alpha.2`) are **not yet published** on the public npm registry (`npm view universal-agent-optimizer` returns `E404`).
- **Do not run `npx uao ...`**: on npm, the unscoped name `uao` belongs to an unrelated `0.0.0` package.
- Until published to npm, install from a local clone or packed `.tgz` tarballs. Once published, use the package-qualified invocation:

```bash
npm exec --yes --package=universal-agent-optimizer -- uao --help
```

## 2. Local / Development Installation (Current Pre-Release Path)

```bash
git clone https://github.com/chthollynotaserious-afk/Agent-token-optimizer.git
cd Agent-token-optimizer
node bin/uao.js --help
```

Or install globally from the local directory:

```bash
npm install --global .
uao --help
```

## 3. Guided Setup (`uao setup`)

Run the interactive setup wizard (or pass `--yes` for non-interactive mode):

```bash
# Local HTTP proxy mode (safe default bind: 127.0.0.1)
uao setup --mode proxy --upstream https://api.openai.com --yes

# Preview without writing any files
uao setup --mode proxy --upstream https://api.openai.com --dry-run
```

Security defaults:
- Default proxy bind address is `127.0.0.1` (never `0.0.0.0`).
- API keys are never written to config files; UAO reads them from environment variables (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `DEEPSEEK_API_KEY`).
- Existing config files are backed up (`*.uao-backup-*`) before modification.

## 4. DSH (DeepSeek Harness) Bundle Installation

Always test in a disposable DSH profile first (never modify your active production profile directly):

```bash
# 1. Pack core and DSH bundle tarballs
npm pack --pack-destination /tmp/uao-pkg
npm pack ./packages/dsh-bundle --pack-destination /tmp/uao-pkg

# 2. In a disposable profile (e.g. uao-test), install via dsh plugin add
dsh plugin --profile uao-test add /tmp/uao-pkg/universal-agent-optimizer-dsh-2.0.0-alpha.2.tgz

# 3. Verify bundle registration and Cordis patch application
dsh --profile uao-test --dump-config
```

Note for pre-publish local testing: because `universal-agent-optimizer` is not yet on npm, add a `pnpm-workspace.yaml` `overrides` entry pointing `universal-agent-optimizer` to the packed core `.tgz` inside the disposable test profile before running `dsh plugin add`.

## 5. Diagnostics (`uao doctor`)

```bash
# Human-readable bilingual output (--lang auto|en|zh-CN)
uao doctor --lang en

# Machine-readable JSON output (language-neutral keys and error codes)
uao doctor --json

# Verify a specific DSH profile
uao doctor --profile uao-test
```

Possible overall statuses: `verified`, `partially_configured`, `unsupported`, `not_installed`.

## 6. Safe Uninstall (`uao uninstall`)

```bash
# Preview removal
uao uninstall --dry-run

# Remove UAO-created config and/or DSH bundle (preserves ledgers and user-authored files)
uao uninstall --profile uao-test --yes

# Also purge UAO-generated ledger/backup files (requires explicit second flag)
uao uninstall --purge-data --confirm-purge --yes
```
