#!/usr/bin/env node
/**
 * Universal Agent Optimizer CLI (`uao`)
 *
 * Commands:
 *   uao proxy [--port 8787] [--host 127.0.0.1] [--upstream <url>] [--provider openai] [--ledger <file>]
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

export function formatHelpText(version = readPackageVersion()) {
  return [
    `Universal Agent Optimizer CLI v${version}`,
    '',
    'Usage:',
    '  uao proxy --upstream <url> [--port 8787] [--host 127.0.0.1] [--provider openai] [--ledger <file>]',
    '  uao benchmark [--json]',
    '  uao inspect-ledger <jsonl-path> [--json]',
    '  uao --help | --version',
    '',
    'Examples:',
    '  npx uao proxy --upstream https://api.openai.com --port 8787',
    '  npx uao benchmark --json',
    '  npx uao inspect-ledger ./data/ledger.jsonl',
  ].join('\n');
}

export async function runCli(argv = [], io = { stdout: console.log, stderr: console.error }) {
  const { command, positionals, flags } = parseArgs(argv);
  const version = readPackageVersion();

  if (flags.version || command === 'version') {
    io.stdout(version);
    return { code: 0, output: version };
  }

  if (flags.help || command === 'help') {
    const text = formatHelpText(version);
    io.stdout(text);
    return { code: 0, output: text };
  }

  if (command === 'benchmark') {
    const report = await runAllBenchmarks();
    if (flags.json) {
      const json = JSON.stringify(report, null, 2);
      io.stdout(json);
      return { code: 0, report };
    }
    const lines = ['=== Universal Agent Optimizer Benchmark (SIMULATED, ZERO API SPEND) ==='];
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
      const msg = 'inspect-ledger: <jsonl-path> is required';
      io.stderr(msg);
      return { code: 1, error: msg };
    }
    const resolved = path.resolve(target);
    if (!fs.existsSync(resolved)) {
      const msg = `inspect-ledger: file not found: ${resolved}`;
      io.stderr(msg);
      return { code: 1, error: msg };
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
      const msg = 'proxy: --upstream <url> (or UAO_UPSTREAM_URL) is required';
      io.stderr(msg);
      return { code: 1, error: msg };
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
    io.stdout(`Universal Agent Optimizer proxy listening on http://${host}:${actualPort} -> ${upstreamBaseUrl} (provider=${provider})`);

    return {
      code: 0,
      server,
      optimizer,
      port: actualPort,
      host,
    };
  }

  const msg = `Unknown command: ${command}\n\n${formatHelpText(version)}`;
  io.stderr(msg);
  return { code: 1, error: msg };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href;
if (isMain) {
  const result = await runCli(process.argv.slice(2));
  if (result.code !== 0) {
    process.exitCode = result.code;
  } else if (result.server) {
    const shutdown = () => {
      result.server.close(() => process.exit(0));
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  }
}
