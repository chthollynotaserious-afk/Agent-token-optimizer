/**
 * Deterministic bilingual i18n helper for the `uao` CLI.
 *
 * Rules:
 * - `--lang auto|en|zh-CN` or `UAO_LANG=en|zh-CN` overrides locale detection.
 * - `auto` uses a deterministic check on `LC_ALL`, `LC_MESSAGES`, `LANG`, and
 *   `Intl.DateTimeFormat().resolvedOptions().locale`, falling back to `en`.
 * - Command names, flags, error codes, JSON keys, and telemetry field names
 *   remain language-neutral.
 */

export const SUPPORTED_LANGS = ['en', 'zh-CN'];

export function normalizeLang(value) {
  if (!value || typeof value !== 'string') return null;
  const trimmed = value.trim().toLowerCase();
  if (trimmed === 'auto') return 'auto';
  if (trimmed === 'en' || trimmed.startsWith('en-') || trimmed.startsWith('en_')) return 'en';
  if (trimmed === 'zh' || trimmed === 'zh-cn' || trimmed === 'zh_cn' || trimmed.startsWith('zh-hans')) {
    return 'zh-CN';
  }
  return null;
}

export function resolveLang(flagLang, env = process.env) {
  const explicit = normalizeLang(flagLang);
  if (explicit && explicit !== 'auto') return explicit;

  const envOverride = normalizeLang(env?.UAO_LANG);
  if (envOverride && envOverride !== 'auto') return envOverride;

  const candidates = [env?.LC_ALL, env?.LC_MESSAGES, env?.LANG];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      if (candidate.trim().toLowerCase().startsWith('zh')) return 'zh-CN';
      if (candidate.trim().toLowerCase().startsWith('en')) return 'en';
    }
  }

  try {
    const intlLocale = Intl.DateTimeFormat().resolvedOptions().locale || '';
    if (intlLocale.toLowerCase().startsWith('zh')) return 'zh-CN';
  } catch {
    // ignore and fall back to en
  }

  return 'en';
}

export function t(lang, enText, zhText) {
  return lang === 'zh-CN' ? zhText : enText;
}

const MESSAGES = {
  en: {
    helpHeader: (version) => `Universal Agent Optimizer CLI v${version}`,
    usageTitle: 'Usage:',
    examplesTitle: 'Examples:',
    unknownCommand: (cmd) => `Unknown command: ${cmd}`,
    missingUpstream: 'proxy: --upstream <url> (or UAO_UPSTREAM_URL) is required',
    missingLedgerPath: 'inspect-ledger: <jsonl-path> is required',
    ledgerNotFound: (p) => `inspect-ledger: file not found: ${p}`,
    proxyListening: ({ host, port, upstreamBaseUrl, provider }) =>
      `Universal Agent Optimizer proxy listening on http://${host}:${port} -> ${upstreamBaseUrl} (provider=${provider})`,
    setupTitle: 'Universal Agent Optimizer — Guided Setup',
    doctorTitle: 'Universal Agent Optimizer — Environment Diagnostics',
    uninstallTitle: 'Universal Agent Optimizer — Safe Uninstall',
  },
  'zh-CN': {
    helpHeader: (version) => `Universal Agent Optimizer CLI v${version}`,
    usageTitle: '用法：',
    examplesTitle: '示例：',
    unknownCommand: (cmd) => `未知命令：${cmd}`,
    missingUpstream: 'proxy：必须提供 --upstream <url>（或设置 UAO_UPSTREAM_URL）',
    missingLedgerPath: 'inspect-ledger：必须提供 <jsonl-path>',
    ledgerNotFound: (p) => `inspect-ledger：文件不存在：${p}`,
    proxyListening: ({ host, port, upstreamBaseUrl, provider }) =>
      `Universal Agent Optimizer 本地代理已启动：http://${host}:${port} -> ${upstreamBaseUrl} (provider=${provider})`,
    setupTitle: 'Universal Agent Optimizer — 交互式安装向导',
    doctorTitle: 'Universal Agent Optimizer — 环境诊断报告',
    uninstallTitle: 'Universal Agent Optimizer — 安全卸载',
  },
};

export function msg(lang, key, ...args) {
  const table = MESSAGES[lang] || MESSAGES.en;
  const entry = table[key] ?? MESSAGES.en[key];
  return typeof entry === 'function' ? entry(...args) : entry;
}
