/**
 * `uao doctor` — Bilingual environment & installation diagnostics.
 *
 * JSON mode (`--json`) keeps all keys, status values, and error codes
 * language-neutral; only `message` is localized.
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  checkPortAvailable,
  findDshBinary,
  getRedactedEnvPresence,
  probeToolVersion,
  readDshProfileManifest,
  redactSecrets,
  resolveDefaultConfigPath,
  resolveDshHomeDir,
  runCommandSafe,
  validateHttpUrl,
} from './env.js';
import { t } from './i18n.js';

function readJsonSafe(filePath) {
  try {
    return { ok: true, data: JSON.parse(fs.readFileSync(filePath, 'utf8')), error: null };
  } catch (err) {
    return { ok: false, data: null, error: redactSecrets(err.message) };
  }
}

function checkNodeSupported(versionStr = process.version) {
  const major = Number(String(versionStr).replace(/^v/, '').split('.')[0]);
  return Number.isFinite(major) && major >= 20;
}

export async function runDoctor(flags = {}, io = { stdout: console.log, stderr: console.error }, lang = 'en') {
  const checks = [];
  const repoRoot = path.resolve(import.meta.dirname, '../..');
  const rootPkgPath = path.join(repoRoot, 'package.json');
  const dshBundleDir = path.join(repoRoot, 'packages', 'dsh-bundle');
  const dshPkgPath = path.join(dshBundleDir, 'package.json');

  // 1. Node.js & package managers
  const nodeSupported = checkNodeSupported(process.version);
  const npm = probeToolVersion('npm');
  const pnpm = probeToolVersion('pnpm');
  checks.push({
    id: 'runtime.node',
    status: nodeSupported ? 'pass' : 'fail',
    code: nodeSupported ? 'OK' : 'NODE_UNSUPPORTED',
    details: { node: process.version, npm: npm.version, pnpm: pnpm.version },
    message: nodeSupported
      ? t(lang, `Node.js ${process.version} is supported (npm=${npm.version || 'n/a'}, pnpm=${pnpm.version || 'n/a'}).`, `Node.js ${process.version} 符合要求（npm=${npm.version || '未安装'}，pnpm=${pnpm.version || '未安装'}）。`)
      : t(lang, `Node.js ${process.version} is unsupported; >=20.0.0 is required.`, `Node.js ${process.version} 不受支持；需要 >=20.0.0。`),
  });

  // 2. UAO package integrity
  const rootPkgRes = readJsonSafe(rootPkgPath);
  const coreEntryExists = fs.existsSync(path.join(repoRoot, 'src', 'index.js'));
  const cliEntryExists = fs.existsSync(path.join(repoRoot, 'bin', 'uao.js'));
  const uaoVersion = rootPkgRes.ok ? rootPkgRes.data.version : 'unknown';
  const pkgIntact = rootPkgRes.ok && coreEntryExists && cliEntryExists;
  checks.push({
    id: 'uao.package',
    status: pkgIntact ? 'pass' : 'fail',
    code: pkgIntact ? 'OK' : 'PACKAGE_INCOMPLETE',
    details: { version: uaoVersion, coreEntryExists, cliEntryExists },
    message: pkgIntact
      ? t(lang, `UAO package v${uaoVersion} core and CLI files are intact.`, `UAO 包 v${uaoVersion} 核心与 CLI 文件完整。`)
      : t(lang, 'UAO package integrity check failed (missing package.json, src/index.js, or bin/uao.js).', 'UAO 包完整性检查失败（缺少 package.json、src/index.js 或 bin/uao.js）。'),
  });

  // 3. DSH CLI presence & version
  const dsh = findDshBinary(typeof flags['dsh-bin'] === 'string' ? flags['dsh-bin'] : null);
  const dshHome = resolveDshHomeDir(typeof flags['dsh-home'] === 'string' ? flags['dsh-home'] : null);
  checks.push({
    id: 'dsh.cli',
    status: dsh.found ? 'pass' : 'info',
    code: dsh.found ? 'OK' : 'DSH_NOT_FOUND',
    details: { found: dsh.found, bin: dsh.bin, version: dsh.version, dshHome },
    message: dsh.found
      ? t(lang, `DSH CLI detected (${dsh.version}) via ${dsh.bin}.`, `检测到 DSH CLI（${dsh.version}），路径：${dsh.bin}。`)
      : t(lang, 'DSH CLI not detected on PATH (proxy and library modes remain available).', '未在 PATH 中检测到 DSH CLI（Proxy 与库集成模式仍可正常使用）。'),
  });

  // 4. DSH bundle manifest & cordis.patch.yml
  let bundleManifestValid = false;
  let patchExists = false;
  if (fs.existsSync(dshPkgPath)) {
    const dshPkgRes = readJsonSafe(dshPkgPath);
    const patchRel = dshPkgRes.ok ? dshPkgRes.data?.dsh?.bundle?.patch : null;
    if (typeof patchRel === 'string' && patchRel.trim()) {
      const resolvedPatch = path.resolve(dshBundleDir, patchRel);
      patchExists = fs.existsSync(resolvedPatch);
      bundleManifestValid = patchExists;
    }
  }
  checks.push({
    id: 'dsh.bundle_manifest',
    status: bundleManifestValid ? 'pass' : 'warn',
    code: bundleManifestValid ? 'OK' : 'BUNDLE_MANIFEST_MISSING',
    details: { manifestExists: fs.existsSync(dshPkgPath), patchExists },
    message: bundleManifestValid
      ? t(lang, 'DSH bundle manifest (`dsh.bundle.patch`) and `cordis.patch.yml` are present.', 'DSH Bundle 清单（`dsh.bundle.patch`）与 `cordis.patch.yml` 存在且有效。')
      : t(lang, 'DSH bundle manifest or `cordis.patch.yml` is missing.', '缺少 DSH Bundle 清单或 `cordis.patch.yml`。'),
  });

  // 5. Profile bundle registration & --dump-config (when --profile provided)
  const profileName = typeof flags.profile === 'string' && flags.profile.trim() ? flags.profile.trim() : null;
  let profileVerified = false;
  if (profileName) {
    const profRes = readDshProfileManifest(dshHome, profileName);
    const bundles = Array.isArray(profRes.manifest?.dsh?.profile?.bundles) ? profRes.manifest.dsh.profile.bundles : [];
    const registered = bundles.includes('universal-agent-optimizer-dsh');
    let dumpHasUao = false;
    let dumpError = null;
    if (dsh.found && profRes.exists) {
      const dump = runCommandSafe(dsh.bin, ['--profile', profileName, '--dump-config'], {
        env: { ...process.env, DSH_HOME: dshHome },
        timeout: 15000,
      });
      if (dump.status === 0) {
        dumpHasUao = /uao-optimizer|universal-agent-optimizer-dsh/.test(dump.stdout);
      } else {
        dumpError = redactSecrets(dump.stderr || dump.stdout);
      }
    }
    profileVerified = registered && dumpHasUao;
    checks.push({
      id: 'dsh.profile',
      status: profileVerified ? 'pass' : (registered ? 'warn' : 'fail'),
      code: profileVerified ? 'OK' : (registered ? 'DUMP_CONFIG_MISSING_ROW' : 'PROFILE_NOT_REGISTERED'),
      details: { profile: profileName, exists: profRes.exists, registered, dumpHasUao, dumpError },
      message: profileVerified
        ? t(lang, `DSH profile "${profileName}" has UAO bundle registered and present in --dump-config.`, `DSH Profile "${profileName}" 已登记 UAO Bundle，且出现在 --dump-config 中。`)
        : t(lang, `DSH profile "${profileName}" is not fully active (registered=${registered}, dumpConfig=${dumpHasUao}).`, `DSH Profile "${profileName}" 尚未完全激活（registered=${registered}, dumpConfig=${dumpHasUao}）。`),
    });
  }

  // 6. User config & env var checks (secrets redacted)
  const configPath = resolveDefaultConfigPath(typeof flags.config === 'string' ? flags.config : null);
  let configData = null;
  let configExists = fs.existsSync(configPath);
  let configValid = true;
  if (configExists) {
    const cfgRes = readJsonSafe(configPath);
    if (cfgRes.ok) {
      configData = cfgRes.data;
      checks.push({
        id: 'uao.config',
        status: 'pass',
        code: 'OK',
        details: { path: configPath, mode: configData?.mode || 'unknown' },
        message: t(lang, `Config loaded from ${configPath} (mode=${configData?.mode || 'unknown'}).`, `已读取配置文件 ${configPath}（mode=${configData?.mode || 'unknown'}）。`),
      });
    } else {
      configValid = false;
      checks.push({
        id: 'uao.config',
        status: 'fail',
        code: 'CONFIG_PARSE_ERROR',
        details: { path: configPath, error: cfgRes.error },
        message: t(lang, `Config parse error at ${configPath}: ${cfgRes.error}`, `配置文件解析失败（${configPath}）：${cfgRes.error}`),
      });
    }
  } else {
    checks.push({
      id: 'uao.config',
      status: 'info',
      code: 'CONFIG_NOT_FOUND',
      details: { path: configPath },
      message: t(lang, `No config file at ${configPath} (run \`uao setup\` to generate one).`, `未找到配置文件 ${configPath}（可运行 \`uao setup\` 生成）。`),
    });
  }

  // 7. Provider URL & optional non-billable connectivity + Proxy bind/port
  const upstreamUrl = typeof flags.upstream === 'string' ? flags.upstream : configData?.upstreamBaseUrl;
  const host = typeof flags.host === 'string' ? flags.host : (configData?.host || '127.0.0.1');
  const port = Number(flags.port ?? configData?.port ?? 8787);

  if (upstreamUrl) {
    const urlCheck = validateHttpUrl(upstreamUrl);
    let reachable = null;
    if (urlCheck.valid && flags['check-connectivity']) {
      try {
        const res = await fetch(urlCheck.url, { method: 'HEAD', signal: AbortSignal.timeout(4000) });
        reachable = res.status < 500;
      } catch {
        reachable = false;
      }
    }
    checks.push({
      id: 'proxy.upstream',
      status: urlCheck.valid ? (reachable === false ? 'warn' : 'pass') : 'fail',
      code: urlCheck.valid ? (reachable === false ? 'UPSTREAM_UNREACHABLE' : 'OK') : 'INVALID_UPSTREAM_URL',
      details: { upstreamUrl, valid: urlCheck.valid, reachable },
      message: urlCheck.valid
        ? t(lang, `Upstream URL is valid (${upstreamUrl})${reachable === null ? '' : `, reachable=${reachable}`}.`, `上游 URL 格式有效（${upstreamUrl}）${reachable === null ? '' : `，连通性=${reachable}`}。`)
        : t(lang, `Upstream URL is invalid: ${upstreamUrl}`, `上游 URL 格式无效：${upstreamUrl}`),
    });
  }

  if (Number.isInteger(port) && port > 0 && port <= 65535) {
    const portRes = await checkPortAvailable(host, port);
    checks.push({
      id: 'proxy.bind',
      status: portRes.available ? 'pass' : 'warn',
      code: portRes.available ? 'OK' : 'PORT_IN_USE',
      details: { host, port, available: portRes.available, error: portRes.error || null },
      message: portRes.available
        ? t(lang, `Proxy bind address ${host}:${port} is available.`, `代理监听地址 ${host}:${port} 可用。`)
        : t(lang, `Proxy bind address ${host}:${port} is busy (${portRes.error}).`, `代理监听地址 ${host}:${port} 已被占用（${portRes.error}）。`),
    });
  }

  const envPresence = getRedactedEnvPresence(['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'DEEPSEEK_API_KEY']);
  checks.push({
    id: 'env.credentials',
    status: 'info',
    code: 'OK',
    details: envPresence,
    message: t(
      lang,
      `Credential env vars (values redacted): OPENAI_API_KEY=${envPresence.OPENAI_API_KEY}, ANTHROPIC_API_KEY=${envPresence.ANTHROPIC_API_KEY}, DEEPSEEK_API_KEY=${envPresence.DEEPSEEK_API_KEY}.`,
      `凭据环境变量状态（已脱敏）：OPENAI_API_KEY=${envPresence.OPENAI_API_KEY}, ANTHROPIC_API_KEY=${envPresence.ANTHROPIC_API_KEY}, DEEPSEEK_API_KEY=${envPresence.DEEPSEEK_API_KEY}。`
    ),
  });

  // Overall status
  let overallStatus = 'not_installed';
  if (!nodeSupported) {
    overallStatus = 'unsupported';
  } else if (profileName) {
    overallStatus = profileVerified && pkgIntact ? 'verified' : 'partially_configured';
  } else if (configExists && configValid && pkgIntact) {
    overallStatus = 'verified';
  } else if (pkgIntact && (configExists || bundleManifestValid)) {
    overallStatus = 'partially_configured';
  }

  const report = {
    status: overallStatus,
    uaoVersion,
    checks,
  };

  if (flags.json) {
    const json = JSON.stringify(report, null, 2);
    io.stdout(json);
    return { code: overallStatus === 'unsupported' ? 1 : 0, report };
  }

  const lines = [
    t(lang, '=== Universal Agent Optimizer — Diagnostics ===', '=== Universal Agent Optimizer — 环境诊断 ==='),
    t(lang, `Overall status: ${overallStatus}`, `总体状态：${overallStatus}`),
    '',
  ];
  for (const c of checks) {
    lines.push(`[${c.status.toUpperCase()}] ${c.id} (${c.code}): ${c.message}`);
  }
  const out = lines.join('\n');
  io.stdout(out);
  return { code: overallStatus === 'unsupported' ? 1 : 0, report, output: out };
}
