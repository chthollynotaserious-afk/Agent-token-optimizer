import assert from 'node:assert/strict';
import test from 'node:test';
import {
  analyzePrefixStability,
  evaluateOptimizationEconomics,
  shouldRewritePrefix,
  getCacheProfile,
} from '../../src/core/cache-economics.js';
import { LEGACY_CNY_PRICE_TABLE } from '../../src/core/model-prices.js';

test('provider cache profiles reflect vendor differences', () => {
  assert.equal(getCacheProfile('anthropic').mechanism, 'explicit_breakpoint');
  assert.equal(getCacheProfile('anthropic').writeMultiplier, 1.25);
  assert.equal(getCacheProfile('deepseek').blockTokens, 64);
  assert.equal(getCacheProfile('local').readMultiplier, 0);
});

test('analyzePrefixStability detects intact prefix vs tool/history breaks', () => {
  const sys = { role: 'system', content: 'You are a helpful coding assistant.' };
  const u1 = { role: 'user', content: 'Read file A' };
  const a1 = { role: 'assistant', content: 'Contents of file A...' };
  const tools = [{ name: 'fs_read', parameters: { type: 'object' } }];

  const ok = analyzePrefixStability({
    prevMessages: [sys, u1, a1],
    nextMessages: [sys, u1, a1, { role: 'user', content: 'Now edit it' }],
    prevTools: tools,
    nextTools: tools,
  });
  assert.equal(ok.prefixIntact, true);
  assert.equal(ok.invalidatedTokens, 0);

  const mutated = analyzePrefixStability({
    prevMessages: [sys, u1, a1],
    nextMessages: [sys, { role: 'user', content: 'SUMMARIZED u1' }, a1],
    prevTools: tools,
    nextTools: tools,
  });
  assert.equal(mutated.prefixIntact, false);
  assert.equal(mutated.divergedAtIndex, 1);
  assert.ok(mutated.invalidatedTokens > 0);

  const toolBreak = analyzePrefixStability({
    prevMessages: [sys, u1],
    nextMessages: [sys, u1],
    prevTools: tools,
    nextTools: [...tools, { name: 'extra_tool' }],
  });
  assert.equal(toolBreak.prefixIntact, false);
  assert.equal(toolBreak.toolsChanged, true);
  assert.ok(toolBreak.invalidatedTokens > 0);
});

test('evaluateOptimizationEconomics distinguishes observed vs estimated and catches negative net savings', () => {
  const econPositive = evaluateOptimizationEconomics({
    baselineUsage: { cacheMiss: 10000, cacheHit: 100000, output: 500 },
    optimizedUsage: { cacheMiss: 2000, cacheHit: 50000, output: 500 },
    overheadCost: 0.001,
    model: 'deepseek-flash',
    provider: 'deepseek',
    at: Date.UTC(2026, 10, 14, 12, 0, 0),
    table: LEGACY_CNY_PRICE_TABLE,
    observed: true,
  });
  assert.equal(econPositive.dataSource, 'observed');
  assert.ok(econPositive.netSavings > 0);
  assert.equal(econPositive.shouldFallback, false);

  // If compression breaks 150k cached prefix -> rebuildPenaltyTokens causes negative net savings!
  const econNegative = evaluateOptimizationEconomics({
    baselineUsage: { cacheMiss: 1000, cacheHit: 150000, output: 200 },
    optimizedUsage: { cacheMiss: 1000, cacheHit: 120000, output: 200 },
    overheadCost: 0.01,
    rebuildPenaltyTokens: 150000,
    model: 'deepseek-flash',
    provider: 'deepseek',
    at: new Date(2026, 10, 14, 14, 0, 0).getTime(),
    table: LEGACY_CNY_PRICE_TABLE,
    observed: false,
  });
  assert.equal(econNegative.dataSource, 'estimated');
  assert.ok(econNegative.netSavings < 0);
  assert.equal(econNegative.shouldFallback, true);
});

test('shouldRewritePrefix rejects short-lived compression that invalidates large cache', () => {
  const deny = shouldRewritePrefix({
    tokensSaved: 5000,
    invalidatedPrefixTokens: 100000,
    expectedRemainingTurns: 2,
    model: 'claude-sonnet-4',
  });
  assert.equal(deny.worthwhile, false);

  const allow = shouldRewritePrefix({
    tokensSaved: 80000,
    invalidatedPrefixTokens: 10000,
    expectedRemainingTurns: 10,
    model: 'claude-sonnet-4',
  });
  assert.equal(allow.worthwhile, true);
});
