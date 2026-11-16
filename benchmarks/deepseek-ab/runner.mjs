#!/usr/bin/env node
/**
 * UAO x Denia x DeepSeek API — Reproducible A/B Benchmark Runner
 *
 * Modes:
 *   --mode mock  (default: zero spend, local HTTP stub for CI/verification)
 *   --mode live  (uses DEEPSEEK_API_KEY env var, enforces --max-cny spending cap)
 *
 * Options:
 *   --smoke              Run smaller fixture counts
 *   --reps 1             Paired repetitions per scenario (A->B and B->A counterbalanced)
 *   --max-cny 5          Hard spending ceiling in RMB (default: 5)
 *   --max-requests 300   Hard request ceiling (default: 300)
 *   --model deepseek-chat
 *   --out-dir <path>
 */

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { execSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import { UniversalAgentOptimizer } from '../../src/core/optimizer.js';
import { DEFAULT_PRICE_TABLE, normalizeUsage, priceUsage } from '../../src/core/model-prices.js';
import { createProxyServer } from '../../src/proxy/server.js';
import { buildFixtureManifest, buildFixtures } from './fixtures.mjs';

const CNY_PER_USD = 7.2;

function parseCliArgs(argv) {
  const opts = {
    mode: 'mock',
    smoke: false,
    reps: 1,
    maxCny: 5.0,
    maxRequests: 300,
    model: 'deepseek-chat',
    baseUrl: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
    outDir: path.resolve(import.meta.dirname, 'output'),
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--mode') opts.mode = argv[++i];
    else if (a === '--smoke') opts.smoke = true;
    else if (a === '--reps') opts.reps = Math.max(1, Number(argv[++i]) || 1);
    else if (a === '--max-cny') opts.maxCny = Math.max(0.01, Number(argv[++i]) || 5.0);
    else if (a === '--max-requests') opts.maxRequests = Math.max(1, Number(argv[++i]) || 300);
    else if (a === '--model') opts.model = argv[++i];
    else if (a === '--base-url') opts.baseUrl = argv[++i];
    else if (a === '--out-dir') opts.outDir = path.resolve(argv[++i]);
  }
  return opts;
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

function startMockDeepSeekServer() {
  const seenPrefixes = new Set();
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {};
      if (body.forceStatus === 429) {
        res.writeHead(429, { 'content-type': 'text/plain' });
        res.end('Mock 429 rate limit');
        return;
      }

      const sysText = (body.messages || []).filter((m) => m.role === 'system').map((m) => m.content).join('\n');
      const totalChars = JSON.stringify(body.messages || []).length + JSON.stringify(body.tools || []).length;
      const promptTokens = Math.max(16, Math.ceil(totalChars / 4));
      const prefixKey = sysText.slice(0, 120);
      const isWarm = prefixKey && seenPrefixes.has(prefixKey);
      if (prefixKey) seenPrefixes.add(prefixKey);

      const cacheHit = isWarm ? Math.floor(promptTokens * 0.7) : 0;
      const cacheMiss = promptTokens - cacheHit;
      const usage = {
        prompt_tokens: promptTokens,
        prompt_cache_hit_tokens: cacheHit,
        prompt_cache_miss_tokens: cacheMiss,
        completion_tokens: 12,
      };

      if (body.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
        res.write(`data: ${JSON.stringify({ id: 'm1', model: body.model, choices: [{ delta: { content: 'OK' } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ id: 'm1', model: body.model, choices: [], usage })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }

      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'mock_resp',
        model: body.model,
        choices: [{ message: { role: 'assistant', content: 'ACK_S0 OK STEP LONG URGENT TOOL_DONE HANDOFF' } }],
        usage,
      }));
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve({ server, url: `http://127.0.0.1:${addr.port}` });
    });
  });
}

async function readSseResponse(res, tStart) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let ttftMs = null;
  let full = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (ttftMs === null) ttftMs = performance.now() - tStart;
    if (value) full += decoder.decode(value, { stream: true });
  }
  const totalMs = performance.now() - tStart;
  let usage = null;
  for (const line of full.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    try {
      const parsed = JSON.parse(payload);
      if (parsed.usage) usage = parsed.usage;
    } catch {}
  }
  return { ttftMs: ttftMs ?? totalMs, totalMs, usage, text: full };
}

export async function runAbBenchmark(opts) {
  const apiKey = opts.mode === 'live' ? (process.env.DEEPSEEK_API_KEY || '') : 'mock-key';
  if (opts.mode === 'live' && !apiKey) {
    throw new Error('DEEPSEEK_API_KEY environment variable is required for --mode live');
  }

  const mockSrv = opts.mode === 'mock' ? await startMockDeepSeekServer() : null;
  const upstreamBaseUrl = mockSrv ? mockSrv.url : opts.baseUrl.replace(/\/$/, '');

  const optimizer = new UniversalAgentOptimizer({
    toolGovernanceConfig: { defaultAllowAll: true },
  });
  const proxy = createProxyServer({
    optimizer,
    upstreamBaseUrl,
    provider: 'deepseek',
    timeoutMs: 30_000,
  });
  await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
  const proxyUrl = `http://127.0.0.1:${proxy.address().port}`;

  const fixtures = buildFixtures({ smoke: opts.smoke });
  const manifest = buildFixtureManifest(fixtures);
  const rows = [];
  let cumulativeCostUsd = 0;
  let totalRequests = 0;
  let abortedReason = null;

  try {
    for (const scenario of fixtures) {
      if (abortedReason) break;
      for (let rep = 1; rep <= opts.reps; rep += 1) {
        if (abortedReason) break;
        // Counterbalance order: odd rep A->B, even rep B->A
        const armOrder = rep % 2 === 1 ? ['A_baseline', 'B_uao'] : ['B_uao', 'A_baseline'];

        for (const arm of armOrder) {
          if (abortedReason) break;
          const sessionId = `bench_${scenario.id}_${arm}_r${rep}`;

          for (const step of scenario.steps) {
            const spentCny = cumulativeCostUsd * CNY_PER_USD;
            if (spentCny >= opts.maxCny) {
              abortedReason = `spending_cap_reached:${spentCny.toFixed(4)}>=${opts.maxCny}`;
              break;
            }
            if (totalRequests >= opts.maxRequests) {
              abortedReason = `request_cap_reached:${totalRequests}>=${opts.maxRequests}`;
              break;
            }

            // Wakeup suppression test in B_uao for S4
            if (step.kind === 'wake' && arm === 'B_uao') {
              const wakeDecision = await optimizer.beforeWake({
                type: step.eventId,
                priority: step.priority,
                dedupKey: step.eventId,
                now: Date.now(),
              });
              if (!wakeDecision.allow) {
                rows.push({
                  scenarioId: scenario.id,
                  rep,
                  order: armOrder.join('->'),
                  arm,
                  step: step.step,
                  cacheState: 'suppressed',
                  status: 0,
                  suppressed: 1,
                  ttftMs: 0,
                  latencyMs: 0,
                  cacheMiss: 0,
                  cacheHit: 0,
                  outputTokens: 0,
                  costUsd: 0,
                  costCny: 0,
                });
                continue;
              }
            }

            // Skip synthetic 429 probe in live mode so we don't abuse live rate limits
            if (step.kind === 'failure_probe' && opts.mode === 'live') {
              continue;
            }

            const targetUrl = arm === 'A_baseline'
              ? `${upstreamBaseUrl}/v1/chat/completions`
              : `${proxyUrl}/v1/chat/completions`;

            const reqBody = {
              model: opts.model,
              messages: step.messages,
              temperature: scenario.temperature,
              max_tokens: scenario.maxTokens,
              stream: Boolean(scenario.stream),
              ...(scenario.tools ? { tools: scenario.tools } : {}),
              ...(step.forceStatus ? { forceStatus: step.forceStatus } : {}),
            };
            if (scenario.stream && opts.mode === 'live') {
              reqBody.stream_options = { include_usage: true };
            }

            const t0 = performance.now();
            totalRequests += 1;
            const res = await fetch(targetUrl, {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                authorization: `Bearer ${apiKey}`,
                'x-session-id': sessionId,
                'x-agent-scene': 'benchmark',
              },
              body: JSON.stringify(reqBody),
            });

            let ttftMs = 0;
            let totalMs = 0;
            let usageRaw = null;
            if (scenario.stream && res.ok && res.headers.get('content-type')?.includes('text/event-stream')) {
              const sse = await readSseResponse(res, t0);
              ttftMs = sse.ttftMs;
              totalMs = sse.totalMs;
              usageRaw = sse.usage;
            } else {
              const text = await res.text();
              totalMs = performance.now() - t0;
              ttftMs = totalMs;
              try {
                const parsed = JSON.parse(text);
                usageRaw = parsed.usage || null;
              } catch {}
            }

            const buckets = normalizeUsage(usageRaw || {});
            const priced = priceUsage(buckets, { model: opts.model, table: DEFAULT_PRICE_TABLE });
            cumulativeCostUsd += priced.cost.total;

            rows.push({
              scenarioId: scenario.id,
              rep,
              order: armOrder.join('->'),
              arm,
              step: step.step,
              cacheState: step.step === 1 ? 'cold' : 'warm',
              status: res.status,
              suppressed: 0,
              ttftMs: Number(ttftMs.toFixed(2)),
              latencyMs: Number(totalMs.toFixed(2)),
              cacheMiss: buckets.cacheMiss,
              cacheHit: buckets.cacheHit,
              outputTokens: buckets.output,
              costUsd: Number(priced.cost.total.toFixed(8)),
              costCny: Number((priced.cost.total * CNY_PER_USD).toFixed(6)),
            });
          }
        }
      }
    }
  } finally {
    proxy.closeAllConnections?.();
    await new Promise((r) => proxy.close(r));
    if (mockSrv) mockSrv.server.close();
  }

  // Aggregate A vs B
  const summarizeArm = (armName) => {
    const subset = rows.filter((r) => r.arm === armName);
    const lats = subset.filter((r) => r.suppressed === 0).map((r) => r.latencyMs).sort((a, b) => a - b);
    const costUsd = subset.reduce((s, r) => s + r.costUsd, 0);
    return {
      requests: subset.filter((r) => r.suppressed === 0).length,
      suppressed: subset.filter((r) => r.suppressed === 1).length,
      cacheHitTokens: subset.reduce((s, r) => s + r.cacheHit, 0),
      cacheMissTokens: subset.reduce((s, r) => s + r.cacheMiss, 0),
      outputTokens: subset.reduce((s, r) => s + r.outputTokens, 0),
      costUsd: Number(costUsd.toFixed(6)),
      costCny: Number((costUsd * CNY_PER_USD).toFixed(4)),
      medianLatencyMs: percentile(lats, 50),
      p90LatencyMs: percentile(lats, 90),
      p95LatencyMs: percentile(lats, 95),
    };
  };

  const armA = summarizeArm('A_baseline');
  const armB = summarizeArm('B_uao');
  const netSavingPct = armA.costUsd > 0 ? ((armA.costUsd - armB.costUsd) / armA.costUsd) * 100 : 0;

  let gitCommit = 'unknown';
  try {
    gitCommit = execSync('git rev-parse --short HEAD', { cwd: path.resolve(import.meta.dirname, '../..'), encoding: 'utf8' }).trim();
  } catch {}

  const envMeta = {
    mode: opts.mode,
    smoke: opts.smoke,
    model: opts.model,
    uaoCommit: gitCommit,
    priceTableVersion: DEFAULT_PRICE_TABLE.version,
    maxCnyCap: opts.maxCny,
    maxRequestsCap: opts.maxRequests,
    abortedReason,
    timestamp: new Date().toISOString(),
  };

  fs.mkdirSync(opts.outDir, { recursive: true });
  const csvHeader = 'scenarioId,rep,order,arm,step,cacheState,status,suppressed,ttftMs,latencyMs,cacheMiss,cacheHit,outputTokens,costUsd,costCny';
  const csvLines = [csvHeader, ...rows.map((r) =>
    [r.scenarioId, r.rep, r.order, r.arm, r.step, r.cacheState, r.status, r.suppressed, r.ttftMs, r.latencyMs, r.cacheMiss, r.cacheHit, r.outputTokens, r.costUsd, r.costCny].join(',')
  )];
  fs.writeFileSync(path.join(opts.outDir, 'raw_metrics.csv'), `${csvLines.join('\n')}\n`, 'utf8');
  fs.writeFileSync(path.join(opts.outDir, 'fixture_manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  fs.writeFileSync(path.join(opts.outDir, 'environment.json'), `${JSON.stringify(envMeta, null, 2)}\n`, 'utf8');

  const reportMd = [
    `# UAO x DeepSeek A/B Benchmark Report (${opts.mode.toUpperCase()})`,
    '',
    `- **Mode:** \`${opts.mode}\` (smoke=${opts.smoke}) | **Model:** \`${opts.model}\` | **UAO Commit:** \`${gitCommit}\``,
    `- **Spending Cap:** ¥${opts.maxCny} | **Total Spent:** ¥${(cumulativeCostUsd * CNY_PER_USD).toFixed(4)} ($${cumulativeCostUsd.toFixed(6)}) | **Aborted:** ${abortedReason || 'none'}`,
    `- **Fixture Manifest Hash:** \`${manifest.manifestHash}\``,
    '',
    '| Arm | Requests | Suppressed | Cache Hit | Cache Miss | Output Tokens | Cost (USD) | Cost (CNY) | Median (ms) | P95 (ms) |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
    `| A (Baseline) | ${armA.requests} | ${armA.suppressed} | ${armA.cacheHitTokens} | ${armA.cacheMissTokens} | ${armA.outputTokens} | $${armA.costUsd} | ¥${armA.costCny} | ${armA.medianLatencyMs} | ${armA.p95LatencyMs} |`,
    `| B (UAO) | ${armB.requests} | ${armB.suppressed} | ${armB.cacheHitTokens} | ${armB.cacheMissTokens} | ${armB.outputTokens} | $${armB.costUsd} | ¥${armB.costCny} | ${armB.medianLatencyMs} | ${armB.p95LatencyMs} |`,
    '',
    `**Net Saving (%):** ${netSavingPct.toFixed(2)}%`,
    '',
    '> Note: In `mock` mode, results reflect simulated local HTTP stub responses only, not live DeepSeek API economics.',
  ].join('\n');
  fs.writeFileSync(path.join(opts.outDir, 'BENCHMARK_REPORT.md'), `${reportMd}\n`, 'utf8');

  return { armA, armB, netSavingPct, envMeta, manifest, rowCount: rows.length };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  const opts = parseCliArgs(process.argv.slice(2));
  runAbBenchmark(opts).then((res) => {
    console.log(JSON.stringify({
      mode: res.envMeta.mode,
      rowCount: res.rowCount,
      armA: res.armA,
      armB: res.armB,
      netSavingPct: Number(res.netSavingPct.toFixed(2)),
      outDir: opts.outDir,
    }, null, 2));
  }).catch((err) => {
    console.error(err.message || err);
    process.exitCode = 1;
  });
}
