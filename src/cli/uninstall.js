/**
 * `uao uninstall` — Safe, reversible removal of UAO-owned artifacts.
 *
 * - Backs up config before removal
 * - Removes only UAO-created config (`createdBy === 'uao-setup'`)
 * - Uses official `dsh plugin --profile <profile> remove` for DSH profiles
 * - Preserves ledgers, audit logs, and user-authored files by default
 * - Requires explicit `--purge-data` + confirmation to delete UAO-generated data
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import {
  backupFileIfExists,
  findDshBinary,
  resolveDefaultConfigPath,
  resolveDshHomeDir,
  runCommandSafe,
} from './env.js';
import { t } from './i18n.js';

export async function runUninstall(flags = {}, io = { stdout: console.log, stderr: console.error }, lang = 'en') {
  const dryRun = Boolean(flags['dry-run']);
  const nonInteractive = Boolean(flags.yes || flags['non-interactive']);
  const isTty = Boolean(process.stdin.isTTY && process.stdout.isTTY) && !nonInteractive;
  const purgeData = Boolean(flags['purge-data']);
  const confirmPurge = Boolean(flags['confirm-purge']);

  const configPath = resolveDefaultConfigPath(typeof flags.config === 'string' ? flags.config : null);
  const configDir = path.dirname(configPath);
  const dshHome = resolveDshHomeDir(typeof flags['dsh-home'] === 'string' ? flags['dsh-home'] : null);

  let configData = null;
  let configOwnedByUao = false;
  if (fs.existsSync(configPath)) {
    try {
      configData = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      configOwnedByUao = configData?.createdBy === 'uao-setup';
    } catch {
      configOwnedByUao = false;
    }
  }

  const targetProfile = typeof flags.profile === 'string' && flags.profile.trim()
    ? flags.profile.trim()
    : (configData?.mode === 'dsh' && typeof configData?.profile === 'string' ? configData.profile : null);

  const actions = [];
  if (targetProfile) {
    actions.push(t(lang, `Remove DSH bundle from profile "${targetProfile}" via official \`dsh plugin remove\``, `通过官方 \`dsh plugin remove\` 从 Profile "${targetProfile}" 移除 UAO Bundle`));
  }
  if (fs.existsSync(configPath)) {
    if (configOwnedByUao) {
      actions.push(t(lang, `Back up and remove UAO-generated config: ${configPath}`, `备份并移除 UAO 生成的配置文件：${configPath}`));
    } else {
      actions.push(t(lang, `Preserve user-authored config (not created by uao setup): ${configPath}`, `保留用户自行编写的配置（非 uao setup 生成）：${configPath}`));
    }
  }

  const dataPathsToPurge = [];
  if (purgeData && fs.existsSync(configDir)) {
    for (const entry of fs.readdirSync(configDir)) {
      if (entry.endsWith('.jsonl') || entry.includes('.uao-backup-')) {
        dataPathsToPurge.push(path.join(configDir, entry));
      }
    }
  }

  io.stdout(t(lang, '=== Universal Agent Optimizer — Safe Uninstall ===', '=== Universal Agent Optimizer — 安全卸载 ==='));
  if (actions.length === 0 && dataPathsToPurge.length === 0) {
    io.stdout(t(lang, 'Nothing to remove. No UAO-owned config or DSH profile specified.', '未发现需要移除的 UAO 自有配置或指定的 DSH Profile。'));
    return { code: 0, removed: [], preserved: [] };
  }

  for (const act of actions) {
    io.stdout(`  - ${act}`);
  }
  if (purgeData) {
    io.stdout(
      t(
        lang,
        `Data purge requested (--purge-data). Candidate paths (${dataPathsToPurge.length}):`,
        `已请求清理 UAO 数据（--purge-data），候选路径（${dataPathsToPurge.length} 项）：`
      )
    );
    for (const p of dataPathsToPurge) {
      io.stdout(`    * ${p}`);
    }
  }

  if (dryRun) {
    io.stdout(t(lang, '[dry-run] No files or DSH profiles were modified.', '[dry-run] 未修改任何文件或 DSH Profile。'));
    return { code: 0, dryRun: true, actions, dataPathsToPurge };
  }

  let rl = null;
  if (isTty) {
    rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  }

  try {
    if (rl) {
      const ok = (await rl.question(t(lang, 'Proceed with uninstall? [y/N]: ', '确认继续卸载？[y/N]： '))).trim();
      if (!/^y(es)?$/i.test(ok)) {
        io.stdout(t(lang, 'Uninstall cancelled.', '已取消卸载。'));
        return { code: 0, cancelled: true };
      }
    }

    const removed = [];
    const preserved = [];
    let backup = null;

    if (targetProfile) {
      const dsh = findDshBinary(typeof flags['dsh-bin'] === 'string' ? flags['dsh-bin'] : null);
      if (!dsh.found) {
        const msg = t(lang, 'uninstall: DSH CLI not found; cannot run official `dsh plugin remove`.', 'uninstall：未检测到 DSH CLI，无法执行官方 `dsh plugin remove`。');
        io.stderr(msg);
        return { code: 1, error: msg };
      }
      const dshPkg = typeof flags['dsh-package'] === 'string' && flags['dsh-package'].trim()
        ? flags['dsh-package'].trim()
        : (configData?.dshPackage || 'universal-agent-optimizer-dsh');
      const res = runCommandSafe(dsh.bin, ['plugin', '--profile', targetProfile, 'remove', dshPkg], {
        env: { ...process.env, DSH_HOME: dshHome },
        timeout: 60000,
      });
      if (res.status !== 0) {
        const msg = t(lang, `uninstall: DSH plugin remove failed: ${res.stderr || res.stdout}`, `uninstall：DSH 插件移除失败：${res.stderr || res.stdout}`);
        io.stderr(msg);
        return { code: 1, error: msg };
      }
      removed.push(`dsh:${targetProfile}:${dshPkg}`);
    }

    if (fs.existsSync(configPath)) {
      if (configOwnedByUao) {
        backup = backupFileIfExists(configPath);
        fs.unlinkSync(configPath);
        removed.push(configPath);
      } else {
        preserved.push(configPath);
      }
    }

    if (purgeData && dataPathsToPurge.length > 0) {
      let allowed = confirmPurge;
      if (!allowed && rl) {
        const ok2 = (await rl.question(t(lang, 'Second confirmation: permanently delete listed UAO data files? [y/N]: ', '二次确认：永久删除上述 UAO 数据文件？[y/N]： '))).trim();
        allowed = /^y(es)?$/i.test(ok2);
      }
      if (allowed) {
        for (const p of dataPathsToPurge) {
          if (fs.existsSync(p)) {
            fs.unlinkSync(p);
            removed.push(p);
          }
        }
      } else {
        io.stdout(t(lang, 'Data purge skipped (requires --confirm-purge or interactive confirmation).', '已跳过数据清理（需要 --confirm-purge 或交互式二次确认）。'));
        preserved.push(...dataPathsToPurge);
      }
    }

    io.stdout(
      t(
        lang,
        `Uninstall complete. Removed: ${removed.length} item(s). Preserved: ${preserved.length} item(s).${backup ? ` Config backup: ${backup}` : ''}`,
        `卸载完成。已移除 ${removed.length} 项，已保留 ${preserved.length} 项。${backup ? `配置备份：${backup}` : ''}`
      )
    );
    return { code: 0, removed, preserved, backup };
  } finally {
    rl?.close();
  }
}
