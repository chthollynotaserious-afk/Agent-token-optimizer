import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  normalizeUsage,
  priceUsage,
  ratesAt,
  LEGACY_CNY_PRICE_TABLE,
  inputTokensOf,
} from '../../src/core/model-prices.js';
import { UniversalTokenLedger } from '../../src/observability/token-ledger.js';
import { CostTracker } from '../../src/observability/cost-tracker.js';
import { CacheTracker } from '../../src/observability/cache-tracker.js';
import { AuditLog } from '../../src/observability/audit-log.js';

test('normalizeUsage handles OpenAI, Anthropic, Gemini, and canonical formats', () => {
  assert.deepEqual(
    normalizeUsage({
      prompt_tokens: 1000,
      completion_tokens: 250,
      prompt_tokens_details: { cached_tokens: 800 },
      completion_tokens_details: { reasoning_tokens: 50 },
    }),
    { cacheMiss: 200, cacheHit: 800, cacheWrite: 0, output: 200, reasoning: 50 }
  );

  assert.deepEqual(
    normalizeUsage({
      input_tokens: 300,
      cache_read_input_tokens: 1200,
      cache_creation_input_tokens: 400,
      output_tokens: 150,
    }),
    { cacheMiss: 300, cacheHit: 1200, cacheWrite: 400, output: 150, reasoning: 0 }
  );

  assert.deepEqual(
    normalizeUsage({
      promptTokenCount: 2000,
      cachedContentTokenCount: 1500,
      candidatesTokenCount: 100,
      thoughtsTokenCount: 40,
    }),
    { cacheMiss: 500, cacheHit: 1500, cacheWrite: 0, output: 100, reasoning: 40 }
  );
});

test('priceUsage calculates exact Anthropic cache read/write tiers and DeepSeek CNY legacy peak/off-peak', () => {
  const anthropic = priceUsage(
    { input_tokens: 1_000_000, cache_read_input_tokens: 1_000_000, cache_creation_input_tokens: 1_000_000, output_tokens: 1_000_000 },
    { model: 'claude-sonnet-4' }
  );
  assert.equal(anthropic.cost.cacheMiss, 3.0);
  assert.equal(anthropic.cost.cacheHit, 0.3);
  assert.equal(anthropic.cost.cacheWrite, 3.75);
  assert.equal(anthropic.cost.output, 15.0);
  assert.equal(anthropic.cost.total, 22.05);

  const offPeakTs = new Date(2026, 10, 14, 3, 0, 0).getTime();
  const peakTs = new Date(2026, 10, 14, 15, 0, 0).getTime();
  const sample = { cacheMiss: 1_000_000, cacheHit: 1_000_000, output: 1_000_000 };
  const off = priceUsage(sample, { model: 'deepseek-flash', at: offPeakTs, table: LEGACY_CNY_PRICE_TABLE });
  const peak = priceUsage(sample, { model: 'deepseek-flash', at: peakTs, table: LEGACY_CNY_PRICE_TABLE });
  assert.equal(off.rates.tier, 'off');
  assert.equal(off.cost.total, 5.25);
  assert.equal(peak.rates.tier, 'peak');
  assert.equal(peak.cost.total, 10.5);
  assert.equal(inputTokensOf(sample), 2_000_000);
});

test('UniversalTokenLedger persists JSONL, aggregates models, and distinguishes observed vs estimated', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uao-ledger-'));
  const ledgerFile = path.join(tmpDir, 'ledger.jsonl');
  try {
    const ledger = new UniversalTokenLedger({ file: ledgerFile });
    ledger.record({
      agentId: 'coding-agent',
      sessionId: 's1',
      provider: 'openai',
      model: 'gpt-4o-mini',
      usage: { prompt_tokens: 1000, completion_tokens: 100, prompt_tokens_details: { cached_tokens: 600 } },
      observed: true,
    });
    ledger.record({
      agentId: 'coding-agent',
      sessionId: 's1',
      provider: 'anthropic',
      model: 'claude-sonnet-4',
      usage: { input_tokens: 500, cache_read_input_tokens: 1500, output_tokens: 200 },
      observed: false,
      overheadCost: 0.0005,
    });

    const reloaded = new UniversalTokenLedger({ file: ledgerFile });
    const sum = reloaded.summary();
    assert.equal(sum.calls, 2);
    assert.equal(sum.observedCalls, 1);
    assert.equal(sum.estimatedCalls, 1);
    assert.equal(sum.inputTokens, 3000);
    assert.equal(sum.buckets.cacheHit, 2100);
    assert.ok(Math.abs(sum.cacheHitRate - 0.7) < 1e-9);
    assert.equal(sum.byModel.length, 2);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('CostTracker, CacheTracker, and AuditLog work cohesively', () => {
  const costTracker = new CostTracker();
  costTracker.trackStep({
    sessionId: 's1',
    model: 'gpt-4o',
    provider: 'openai',
    baselineUsage: { prompt_tokens: 10000, completion_tokens: 200 },
    optimizedUsage: { prompt_tokens: 5000, completion_tokens: 200, prompt_tokens_details: { cached_tokens: 4000 } },
    observed: true,
  });
  const report = costTracker.report();
  assert.equal(report.steps, 1);
  assert.equal(report.observedCount, 1);
  assert.ok(report.netSavings > 0);

  const cacheTracker = new CacheTracker();
  const s1 = cacheTracker.inspectRequest({ sessionId: 's1', messages: [{ role: 'system', content: 'A' }] });
  const s2 = cacheTracker.inspectRequest({
    sessionId: 's1',
    messages: [{ role: 'system', content: 'A' }, { role: 'user', content: 'B' }],
  });
  assert.equal(s1.prefixIntact, true);
  assert.equal(s2.prefixIntact, true);
  assert.equal(cacheTracker.stats().breaks, 0);

  const audit = new AuditLog();
  audit.log('gate', 'skip', { reason: 'cooldown' });
  assert.equal(audit.query({ category: 'gate' }).length, 1);
});

test('ratesAt and priceUsage resolve OpenRouter vendor/model slugs, longest-match snapshots, :free tiers, and upstream usage.cost', () => {
  const mini = ratesAt('openai/gpt-4o-mini');
  assert.equal(mini.estimated, false);
  assert.equal(mini.cacheMiss, 0.15);
  assert.equal(mini.cacheHit, 0.075);
  assert.equal(mini.output, 0.6);

  const datedMini = ratesAt('openai/gpt-4o-mini-2024-07-18');
  assert.equal(datedMini.estimated, true);
  assert.equal(datedMini.cacheMiss, 0.15);
  assert.equal(datedMini.output, 0.6);

  const dotHaiku = ratesAt('anthropic/claude-3.5-haiku');
  assert.equal(dotHaiku.estimated, false);
  assert.equal(dotHaiku.cacheMiss, 0.8);
  assert.equal(dotHaiku.cacheWrite, 1.0);

  const gpt41 = ratesAt('openai/gpt-4.1');
  assert.equal(gpt41.estimated, false);
  assert.equal(gpt41.cacheMiss, 2.0);

  const nitro = ratesAt('openai/gpt-4o-mini:nitro');
  assert.equal(nitro.estimated, true);
  assert.equal(nitro.cacheMiss, 0.15);

  const freeTier = ratesAt('deepseek/deepseek-chat:free');
  assert.equal(freeTier.estimated, false);
  assert.equal(freeTier.cacheMiss, 0);
  assert.equal(freeTier.output, 0);

  const upstreamPaid = priceUsage(
    { prompt_tokens: 1000, completion_tokens: 200, prompt_tokens_details: { cached_tokens: 500 }, cost: 0.00123 },
    { model: 'openai/gpt-4o-mini' }
  );
  assert.equal(upstreamPaid.cost.costSource, 'upstream');
  assert.equal(upstreamPaid.cost.total, 0.00123);

  const upstreamZero = priceUsage(
    { prompt_tokens: 1000, completion_tokens: 200, cost: 0 },
    { model: 'unknown-vendor/custom-model' }
  );
  assert.equal(upstreamZero.cost.costSource, 'upstream');
  assert.equal(upstreamZero.cost.cacheMiss, 0);
  assert.equal(upstreamZero.cost.output, 0);
  assert.equal(upstreamZero.cost.total, 0);

  const ledger = new UniversalTokenLedger();
  const entry = ledger.record({
    provider: 'openrouter',
    model: 'unknown-vendor/custom-model',
    usage: { prompt_tokens: 500, completion_tokens: 100, cost: 0.00042 },
    observed: true,
  });
  assert.equal(entry.cost.costSource, 'upstream');
  assert.equal(entry.totalCost, 0.00042);
  assert.equal(entry.estimatedPrice, false);
  assert.equal(entry.dataSource, 'observed');
});
