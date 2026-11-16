/**
 * `uao setup` — Guided, safe installer for Universal Agent Optimizer.
 *
 * Supports:
 * - Interactive TTY mode with bilingual prompts and explicit confirmation
 * - Non-interactive mode (`--yes` / `--non-interactive` or `--dry-run`)
 * - Modes: `dsh` (DSH bundle), `proxy` (local HTTP proxy), `library` (SDK integration)
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import {
  backupFileIfExists,
  findDshBinary,
  listDshProfiles,
  probeToolVersion,
  resolveDefaultConfigPath,
  resolveDshHomeDir,
  runCommandSafe,
  validateHttpUrl,
} from './env.js';
import { t } from './i18n.js';

const VALID_MODES = new Set(['dsh', 'proxy', 'library']);
const DEFAULT_PROVIDER_UPSTREAMS = {
  openai: 'https://api.openai.com',
  anthropic: 'https://api.anthropic.com',
  deepseek: 'https://api.deepseek.com',
};
const DEFAULT_PROVIDER_ENV_VARS = {
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
};

export function detectSetupEnvironment({ dshBin = null, dshHome = null, env = process.env } = {}) {
  const npm = probeToolVersion('npm');
  const pnpm = probeToolVersion('pnpm');
  const dsh = findDshBinary(dshBin, env);
  const resolvedDshHome = resolveDshHomeDir(dshHome, env);
  const profiles = listDshProfiles(resolvedDshHome);

  return {
    os: `${os.platform()} ${os.release()} (${os.arch()})`,
    nodeVersion: process.version,
    npm,
    pnpm,
    dsh,
    dshHome: resolvedDshHome,
    dshProfiles: profiles,
  };
}

async function promptChoice(rl, question, defaultValue) {
  const answer = (await rl.question(`${question} `)).trim();
  return answer || defaultValue;
}

export async function runSetup(flags = {}, io = { stdout: console.log, stderr: console.error }, lang = 'en') {
  const envInfo = detectSetupEnvironment({
    dshBin: typeof flags['dsh-bin'] === 'string' ? flags['dsh-bin'] : null,
    dshHome: typeof flags['dsh-home'] === 'string' ? flags['dsh-home'] : null,
  });

  const dryRun = Boolean(flags['dry-run']);
  const nonInteractive = Boolean(flags.yes || flags['non-interactive']);
  const isTty = Boolean(process.stdin.isTTY && process.stdout.isTTY) && !nonInteractive;

  io.stdout(t(lang, '=== Universal Agent Optimizer — Guided Setup ===', '=== Universal Agent Optimizer — 交互式安装向导 ==='));
  io.stdout(
    t(
      lang,
      `Detected: OS=${envInfo.os} | Node=${envInfo.nodeVersion} | npm=${envInfo.npm.version || 'missing'} | pnpm=${envInfo.pnpm.version || 'missing'} | DSH=${envInfo.dsh.found ? envInfo.dsh.version : 'not found'}`,
      `环境检测：OS=${envInfo.os} | Node=${envInfo.nodeVersion} | npm=${envInfo.npm.version || '未安装'} | pnpm=${envInfo.pnpm.version || '未安装'} | DSH=${envInfo.dsh.found ? envInfo.dsh.version : '未检测到'}`
    )
  );

  let mode = typeof flags.mode === 'string' ? flags.mode.trim().toLowerCase() : '';
  let rl = null;
  if (isTty) {
    rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  }

  try {
    if (!VALID_MODES.has(mode)) {
      if (rl) {
        io.stdout(
          t(
            lang,
            '\nSelect integration mode:\n  1) dsh     — DSH (DeepSeek Harness) bundle plugin\n  2) proxy   — Local HTTP proxy (OpenAI / Anthropic / DeepSeek compatible)\n  3) library — Node.js / Python library integration',
            '\n请选择集成模式：\n  1) dsh     — DSH（DeepSeek Harness）Bundle 插件\n  2) proxy   — 本地 HTTP 代理（兼容 OpenAI / Anthropic / DeepSeek）\n  3) library — Node.js / Python 代码库集成'
          )
        );
        const choice = await promptChoice(rl, t(lang, 'Mode [dsh/proxy/library] (default: proxy):', '模式 [dsh/proxy/library]（默认：proxy）：'), 'proxy');
        mode = choice === '1' ? 'dsh' : choice === '2' ? 'proxy' : choice === '3' ? 'library' : choice.toLowerCase();
      } else {
        mode = envInfo.dsh.found ? 'dsh' : 'proxy';
      }
    }

    if (!VALID_MODES.has(mode)) {
      const errMsg = t(lang, `setup: invalid --mode "${mode}". Expected dsh, proxy, or library.`, `setup：无效的 --mode "${mode}"，应为 dsh、proxy 或 library。`);
      io.stderr(errMsg);
      return { code: 1, error: errMsg };
    }

    const configPath = resolveDefaultConfigPath(typeof flags.config === 'string' ? flags.config : null);

    if (mode === 'dsh') {
      if (!envInfo.dsh.found) {
        const msg = t(
          lang,
          'setup: DSH CLI was not found on PATH. Install DSH first or pass --dsh-bin <path>, or use --mode proxy.',
          'setup：未在 PATH 中检测到 DSH CLI。请先安装 DSH 或通过 --dsh-bin <path> 指定路径，或改用 --mode proxy。'
        );
        io.stderr(msg);
        return { code: 1, error: msg };
      }

      let profile = typeof flags.profile === 'string' ? flags.profile.trim() : '';
      if (!profile) {
        if (rl) {
          if (envInfo.dshProfiles.length > 0) {
            io.stdout(t(lang, `Existing DSH profiles: ${envInfo.dshProfiles.join(', ')}`, `现有 DSH Profile：${envInfo.dshProfiles.join(', ')}`));
          }
          profile = await promptChoice(
            rl,
            t(lang, 'Target DSH profile name (recommended disposable test profile: uao-test):', '目标 DSH Profile 名称（建议先用一次性测试 Profile：uao-test）：'),
            'uao-test'
          );
        } else {
          const msg = t(
            lang,
            'setup: --profile <name> is required in non-interactive DSH mode so active profiles are never modified implicitly.',
            'setup：非交互式 DSH 模式必须显式指定 --profile <name>，绝不隐式猜测或修改生产 Profile。'
          );
          io.stderr(msg);
          return { code: 1, error: msg };
        }
      }

      const dshPkg = typeof flags['dsh-package'] === 'string' && flags['dsh-package'].trim()
        ? flags['dsh-package'].trim()
        : 'universal-agent-optimizer-dsh';

      const proposedConfig = {
        mode: 'dsh',
        profile,
        dshPackage: dshPkg,
        dshHome: envInfo.dshHome,
        createdBy: 'uao-setup',
      };

      io.stdout(t(lang, `\nProposed DSH action:\n  1. Run: ${envInfo.dsh.bin} plugin --profile ${profile} add ${dshPkg}\n  2. Write UAO metadata config to: ${configPath}`, `\n即将执行的 DSH 操作：\n  1. 执行：${envInfo.dsh.bin} plugin --profile ${profile} add ${dshPkg}\n  2. 写入 UAO 配置元数据到：${configPath}`));

      if (dryRun) {
        io.stdout(t(lang, '[dry-run] No files or DSH profiles were modified.', '[dry-run] 未修改任何文件或 DSH Profile。'));
        return { code: 0, dryRun: true, mode, profile, configPath, proposedConfig };
      }

      if (rl) {
        const confirm = await promptChoice(rl, t(lang, 'Proceed with installation? [y/N]:', '确认继续安装？[y/N]：'), 'n');
        if (!/^y(es)?$/i.test(confirm)) {
          io.stdout(t(lang, 'Setup cancelled by user.', '用户已取消安装。'));
          return { code: 0, cancelled: true };
        }
      }

      const installRes = runCommandSafe(envInfo.dsh.bin, ['plugin', '--profile', profile, 'add', dshPkg], {
        env: { ...process.env, DSH_HOME: envInfo.dshHome },
        timeout: 60000,
      });

      if (installRes.status !== 0) {
        const errMsg = t(
          lang,
          `setup: DSH plugin installation failed (exit=${installRes.status}). ${installRes.stderr || installRes.stdout}`,
          `setup：DSH 插件安装失败（exit=${installRes.status}）。${installRes.stderr || installRes.stdout}`
        );
        io.stderr(errMsg);
        return { code: 1, error: errMsg, details: installRes };
      }

      const backup = backupFileIfExists(configPath);
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(configPath, `${JSON.stringify(proposedConfig, null, 2)}\n`, 'utf8');

      io.stdout(
        t(
          lang,
          `\nSuccess! UAO DSH bundle installed into profile "${profile}".\n${backup ? `Backup created: ${backup}\n` : ''}Next command: uao doctor --profile ${profile}`,
          `\n安装成功！UAO DSH Bundle 已安装到 Profile "${profile}"。\n${backup ? `已创建备份：${backup}\n` : ''}下一步诊断命令：uao doctor --profile ${profile}`
        )
      );
      return { code: 0, mode, profile, configPath, backup };
    }

    if (mode === 'proxy') {
      const provider = typeof flags.provider === 'string' && flags.provider.trim()
        ? flags.provider.trim().toLowerCase()
        : 'openai';
      const defaultUpstream = DEFAULT_PROVIDER_UPSTREAMS[provider] || DEFAULT_PROVIDER_UPSTREAMS.openai;
      let upstream = typeof flags.upstream === 'string' && flags.upstream.trim()
        ? flags.upstream.trim()
        : defaultUpstream;

      if (rl && !flags.upstream) {
        upstream = await promptChoice(
          rl,
          t(lang, `Upstream provider base URL (default: ${defaultUpstream}):`, `上游 Provider Base URL（默认：${defaultUpstream}）：`),
          defaultUpstream
        );
      }

      const urlCheck = validateHttpUrl(upstream);
      if (!urlCheck.valid) {
        const msg = t(lang, `setup: invalid --upstream URL "${upstream}"`, `setup：无效的 --upstream URL "${upstream}"`);
        io.stderr(msg);
        return { code: 1, error: msg };
      }

      const host = typeof flags.host === 'string' && flags.host.trim() ? flags.host.trim() : '127.0.0.1';
      const port = Number(flags.port ?? 8787);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        const msg = t(lang, `setup: invalid --port "${flags.port}"`, `setup：无效的 --port "${flags.port}"`);
        io.stderr(msg);
        return { code: 1, error: msg };
      }

      const envKeyName = DEFAULT_PROVIDER_ENV_VARS[provider] || 'OPENAI_API_KEY';
      const proposedConfig = {
        mode: 'proxy',
        provider,
        upstreamBaseUrl: upstream,
        host,
        port,
        apiKeyEnvVar: envKeyName,
        createdBy: 'uao-setup',
      };

      io.stdout(
        t(
          lang,
          `\nProxy configuration preview (${configPath}):\n${JSON.stringify(proposedConfig, null, 2)}\nNote: API keys are read from environment variable ${envKeyName} and never stored in config.`,
          `\n代理配置预览（${configPath}）：\n${JSON.stringify(proposedConfig, null, 2)}\n说明：API Key 将从环境变量 ${envKeyName} 读取，绝不以明文写入配置文件。`
        )
      );

      if (dryRun) {
        io.stdout(t(lang, '[dry-run] No files were written.', '[dry-run] 未写入任何文件。'));
        return { code: 0, dryRun: true, mode, configPath, proposedConfig };
      }

      if (rl) {
        const confirm = await promptChoice(rl, t(lang, 'Write this configuration? [y/N]:', '确认写入此配置？[y/N]：'), 'n');
        if (!/^y(es)?$/i.test(confirm)) {
          io.stdout(t(lang, 'Setup cancelled by user.', '用户已取消安装。'));
          return { code: 0, cancelled: true };
        }
      }

      const backup = backupFileIfExists(configPath);
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(configPath, `${JSON.stringify(proposedConfig, null, 2)}\n`, 'utf8');

      io.stdout(
        t(
          lang,
          `\nSuccess! Proxy config saved to ${configPath}.\n${backup ? `Backup created: ${backup}\n` : ''}Next commands:\n  1. uao doctor --config "${configPath}"\n  2. uao proxy --upstream ${upstream} --host ${host} --port ${port} --provider ${provider}\n  3. Point your agent's base_url to http://${host}:${port}/v1`,
          `\n配置成功！代理配置已保存到 ${configPath}。\n${backup ? `已创建备份：${backup}\n` : ''}下一步命令：\n  1. uao doctor --config "${configPath}"\n  2. uao proxy --upstream ${upstream} --host ${host} --port ${port} --provider ${provider}\n  3. 将你的 Agent 的 base_url 指向 http://${host}:${port}/v1`
        )
      );
      return { code: 0, mode, configPath, backup, proposedConfig };
    }

    // library mode
    const proposedConfig = {
      mode: 'library',
      package: 'universal-agent-optimizer',
      createdBy: 'uao-setup',
    };
    io.stdout(
      t(
        lang,
        `\nLibrary integration snippet (ESM):\n  import { UniversalAgentOptimizer } from 'universal-agent-optimizer';\n  const optimizer = new UniversalAgentOptimizer();\n\nConfig metadata path: ${configPath}`,
        `\n代码库集成示例（ESM）：\n  import { UniversalAgentOptimizer } from 'universal-agent-optimizer';\n  const optimizer = new UniversalAgentOptimizer();\n\n配置元数据路径：${configPath}`
      )
    );

    if (dryRun) {
      io.stdout(t(lang, '[dry-run] No files were written.', '[dry-run] 未写入任何文件。'));
      return { code: 0, dryRun: true, mode, configPath, proposedConfig };
    }

    if (rl) {
      const confirm = await promptChoice(rl, t(lang, 'Save library mode metadata? [y/N]:', '确认保存库模式配置元数据？[y/N]：'), 'n');
      if (!/^y(es)?$/i.test(confirm)) {
        io.stdout(t(lang, 'Setup cancelled by user.', '用户已取消安装。'));
        return { code: 0, cancelled: true };
      }
    }

    const backup = backupFileIfExists(configPath);
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, `${JSON.stringify(proposedConfig, null, 2)}\n`, 'utf8');

    io.stdout(
      t(
        lang,
        `\nSuccess! Library integration metadata saved to ${configPath}.\nNext command: uao doctor --config "${configPath}"`,
        `\n配置成功！库集成元数据已保存到 ${configPath}。\n下一步命令：uao doctor --config "${configPath}"`
      )
    );
    return { code: 0, mode, configPath, backup, proposedConfig };
  } finally {
    rl?.close();
  }
}
