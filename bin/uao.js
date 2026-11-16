#!/usr/bin/env node
/**
 * Universal Agent Optimizer CLI (`uao`)
 *
 * Commands:
 *   uao setup     [--mode dsh|proxy|library] [--profile <name>] [--lang auto|en|zh-CN]
 *   uao doctor    [--profile <name>] [--config <path>] [--json] [--lang auto|en|zh-CN]
 *   uao uninstall [--profile <name>] [--config <path>] [--purge-data] [--lang auto|en|zh-CN]
 *   uao proxy     [--port 8787] [--host 127.0.0.1] [--upstream <url>] [--provider openai] [--ledger <file>]
 *   uao benchmark [--json]
 *   uao inspect-ledger <jsonl-path> [--json]
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { UniversalAgentOptimizer } from '../src/core/optimizer.js';
import { UniversalTokenLedger } from '../src/observability/token-ledger.js';
import { createProxyServer } from '../src/proxy/server.js';
import { runAllBenchmarks } from '../tests/benchmark/run-benchmark.mjs';
import { msg, resolveLang, t } from '../src/cli/i18n.js';
import { runSetup } from '../src/cli/setup.js';
import { runDoctor } from '../src/cli/doctor.js';
import { runUninstall } from '../src/cli/uninstall.js';

function readPackageVersion() {
  try {
    const pkgPath = new URL('../package.json', import.meta.url);
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    return pkg.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export function parseArgs(argv = []) {
  const positionals = [];
  const flags = {};

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--help' || token === '-h') {
      flags.help = true;
    } else if (token === '--version' || token === '-v') {
      flags.version = true;
    } else if (token.startsWith('--')) {
      const eqIdx = token.indexOf('=');
      if (eqIdx !== -1) {
        flags[token.slice(2, eqIdx)] = token.slice(eqIdx + 1);
      } else {
        const key = token.slice(2);
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('-')) {
          flags[key] = next;
          i += 1;
        } else {
          flags[key] = true;
        }
      }
    } else {
      positionals.push(token);
    }
  }

  return {
    command: positionals[0] || (flags.version ? 'version' : 'help'),
    positionals,
    flags,
  };
}

export function formatHelpText(version = readPackageVersion(), lang = 'en') {
  return [
    msg(lang, 'helpHeader', version),
    '',
    msg(lang, 'usageTitle'),
    '  uao setup [--mode dsh|proxy|library] [--profile <name>] [--dry-run] [--yes] [--lang auto|en|zh-CN]',
    '  uao doctor [--profile <name>] [--config <path>] [--check-connectivity] [--json] [--lang auto|en|zh-CN]',
    '  uao uninstall [--profile <name>] [--config <path>] [--purge-data] [--dry-run] [--yes] [--lang auto|en|zh-CN]',
    '  uao proxy --upstream <url> [--port 8787] [--host 127.0.0.1] [--provider openai] [--ledger <file>]',
    '  uao benchmark [--json]',
    '  uao inspect-ledger <jsonl-path> [--json]',
    '  uao --help | --version',
    '',
    msg(lang, 'examplesTitle'),
    '  uao setup --mode proxy --upstream https://api.openai.com',
    '  uao doctor --json',
    '  uao proxy --upstream https://api.openai.com --port 8787',
    '  uao benchmark --json',
    '  uao inspect-ledger ./data/ledger.jsonl',
    '',
    t(
      lang,
      'Note: If invoking via npm exec after publishing, use: npm exec --yes --package=universal-agent-optimizer -- uao --help',
      '提示：发布到 npm 后如需通过 npm exec 调用，请使用：npm exec --yes --package=universal-agent-optimizer -- uao --help'
    ),
  ].join('\n');
}

export async function runCli(argv = [], io = { stdout: console.log, stderr: console.error }) {
  const { command, positionals, flags } = parseArgs(argv);
  const version = readPackageVersion();
  const lang = resolveLang(flags.lang);

  if (flags.version || command === 'version') {
    io.stdout(version);
    return { code: 0, output: version };
  }

  if (flags.help || command === 'help') {
    const text = formatHelpText(version, lang);
    io.stdout(text);
    return { code: 0, output: text };
  }

  if (command === 'setup') {
    return runSetup(flags, io, lang);
  }

  if (command === 'doctor') {
    return runDoctor(flags, io, lang);
  }

  if (command === 'uninstall') {
    return runUninstall(flags, io, lang);
  }

  if (command === 'benchmark') {
    const report = await runAllBenchmarks();
    if (flags.json) {
      const json = JSON.stringify(report, null, 2);
      io.stdout(json);
      return { code: 0, report };
    }
    const lines = [
      t(
        lang,
        '=== Universal Agent Optimizer Benchmark (SIMULATED, ZERO API SPEND) ===',
        '=== Universal Agent Optimizer 基准测试（纯模拟，零 API 费用）==='
      ),
    ];
    for (const s of report.scenarios) {
      lines.push(
        `${s.id} [${s.model}] ${s.name}: Base=$${s.baseline.cost.toFixed(5)} -> Opt=$${(s.optimized.cost + s.optimized.overheadCost).toFixed(5)} | NetSave=${s.optimized.savingsPct.toFixed(1)}% | TaskOK=${(s.optimized.taskSuccessRate * 100).toFixed(0)}%`
      );
    }
    const out = lines.join('\n');
    io.stdout(out);
    return { code: 0, report, output: out };
  }

  if (command === 'inspect-ledger') {
    const target = positionals[1] || flags.file;
    if (!target || typeof target !== 'string') {
      const errText = msg(lang, 'missingLedgerPath');
      io.stderr(errText);
      return { code: 1, error: errText };
    }
    const resolved = path.resolve(target);
    if (!fs.existsSync(resolved)) {
      const errText = msg(lang, 'ledgerNotFound', resolved);
      io.stderr(errText);
      return { code: 1, error: errText };
    }
    const ledger = new UniversalTokenLedger({ file: resolved });
    const summary = ledger.summary();
    if (flags.json) {
      const json = JSON.stringify(summary, null, 2);
      io.stdout(json);
      return { code: 0, summary };
    }
    const lines = [
      `Ledger: ${resolved}`,
      `Calls: ${summary.calls} (observed=${summary.observedCalls}, estimated=${summary.estimatedCalls})`,
      `API Cost: $${summary.apiCost.toFixed(6)} | Overhead: $${summary.overheadCost.toFixed(6)} | Total: $${summary.totalCost.toFixed(6)}`,
      `Tokens: input=${summary.inputTokens} (cacheHit=${summary.buckets.cacheHit}, cacheMiss=${summary.buckets.cacheMiss}, cacheWrite=${summary.buckets.cacheWrite}) | output=${summary.buckets.output}`,
    ];
    const out = lines.join('\n');
    io.stdout(out);
    return { code: 0, summary, output: out };
  }

  if (command === 'proxy') {
    const upstreamBaseUrl = String(flags.upstream || process.env.UAO_UPSTREAM_URL || '').trim();
    if (!upstreamBaseUrl) {
      const errText = msg(lang, 'missingUpstream');
      io.stderr(errText);
      return { code: 1, error: errText };
    }
    const port = Number(flags.port ?? process.env.UAO_PORT ?? 8787);
    const host = String(flags.host || process.env.UAO_HOST || '127.0.0.1');
    const provider = String(flags.provider || process.env.UAO_PROVIDER || 'openai');
    const ledgerFile = typeof flags.ledger === 'string' ? path.resolve(flags.ledger) : null;

    const optimizer = new UniversalAgentOptimizer({ ledgerFile });
    const server = createProxyServer({ optimizer, upstreamBaseUrl, provider });

    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, resolve);
    });

    const address = server.address();
    const actualPort = typeof address === 'object' && address ? address.port : port;
    io.stdout(msg(lang, 'proxyListening', { host, port: actualPort, upstreamBaseUrl, provider }));

    return {
      code: 0,
      server,
      optimizer,
      port: actualPort,
      host,
    };
  }

  const errText = `${msg(lang, 'unknownCommand', command)}\n\n${formatHelpText(version, lang)}`;
  io.stderr(errText);
  return { code: 1, error: errText };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  runCli(process.argv.slice(2)).then((res) => {
    if (res && res.code && res.code !== 0) {
      process.exitCode = res.code;
    }
  }).catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
