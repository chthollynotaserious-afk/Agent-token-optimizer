/**
 * Cache-Aware Cost Optimization Engine
 *
 * Models real API net savings rather than raw token compression ratio:
 *   Net Savings = Baseline Cost - (Optimized API Cost + Compression Overhead + Cache Rebuild Cost)
 *
 * Explicitly distinguishes `observed` provider cache telemetry from `estimated` values
 * and models provider-specific caching semantics.
 */

import { DEFAULT_PRICE_TABLE, normalizeUsage, priceUsage, ratesAt, inputTokensOf } from './model-prices.js';

export const PROVIDER_CACHE_PROFILES = Object.freeze({
  deepseek: Object.freeze({
    mechanism: 'prefix_auto',
    blockTokens: 64,
    ttlSeconds: 300,
    minCacheableTokens: 64,
    writeMultiplier: 1.0,
    readMultiplier: 0.25,
    supportsCacheReadField: true,
  }),
  openai: Object.freeze({
    mechanism: 'prefix_auto',
    blockTokens: 128,
    ttlSeconds: 300,
    minCacheableTokens: 1024,
    writeMultiplier: 1.0,
    readMultiplier: 0.5,
    supportsCacheReadField: true,
  }),
  anthropic: Object.freeze({
    mechanism: 'explicit_breakpoint',
    blockTokens: 1,
    ttlSeconds: 300,
    minCacheableTokens: 1024,
    writeMultiplier: 1.25,
    readMultiplier: 0.1,
    supportsCacheReadField: true,
  }),
  gemini: Object.freeze({
    mechanism: 'implicit_or_explicit_cache',
    blockTokens: 1,
    ttlSeconds: 3600,
    minCacheableTokens: 1024,
    writeMultiplier: 1.0,
    readMultiplier: 0.25,
    supportsCacheReadField: true,
  }),
  local: Object.freeze({
    mechanism: 'kv_prefix_reuse',
    blockTokens: 16,
    ttlSeconds: Infinity,
    minCacheableTokens: 16,
    writeMultiplier: 1.0,
    readMultiplier: 0.0,
    supportsCacheReadField: false,
  }),
});

export function getCacheProfile(provider = 'deepseek') {
  const key = String(provider || 'deepseek').toLowerCase();
  return PROVIDER_CACHE_PROFILES[key] || PROVIDER_CACHE_PROFILES.deepseek;
}

/**
 * Estimate token count conservatively from text or structured JSON (~3.5 chars/token fallback).
 */
export function estimateTokens(value) {
  if (value == null) return 0;
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (!text) return 0;
  // Count CJK characters closer to 1.2 chars/token and ASCII ~4 chars/token
  let cjk = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code >= 0x4e00 && code <= 0x9fff) cjk += 1;
  }
  const nonCjk = text.length - cjk;
  return Math.max(1, Math.ceil(cjk * 0.85 + nonCjk / 4));
}

function serializeMsg(msg) {
  if (typeof msg === 'string') return msg;
  try {
    return JSON.stringify(msg ?? null);
  } catch {
    return String(msg ?? '');
  }
}

/**
 * Check prefix stability between previous and next request payloads.
 * Any mutation in tool schemas or early messages invalidates downstream KV cache!
 */
export function analyzePrefixStability({
  prevMessages = [],
  nextMessages = [],
  prevTools = [],
  nextTools = [],
} = {}) {
  const prevToolsStr = serializeMsg(prevTools);
  const nextToolsStr = serializeMsg(nextTools);
  const toolsChanged = prevToolsStr !== nextToolsStr;

  if (toolsChanged) {
    const prevTotalTokens = estimateTokens(prevToolsStr)
      + prevMessages.reduce((sum, m) => sum + estimateTokens(m), 0);
    return {
      prefixIntact: false,
      toolsChanged: true,
      divergedAtIndex: -1,
      preservedTokens: 0,
      invalidatedTokens: prevTotalTokens,
      reason: 'tool_schema_changed',
    };
  }

  let divergedAtIndex = -1;
  let preservedTokens = estimateTokens(nextToolsStr);
  const minLen = Math.min(prevMessages.length, nextMessages.length);
  for (let i = 0; i < minLen; i += 1) {
    const a = serializeMsg(prevMessages[i]);
    const b = serializeMsg(nextMessages[i]);
    if (a !== b) {
      divergedAtIndex = i;
      break;
    }
    preservedTokens += estimateTokens(b);
  }
  if (divergedAtIndex === -1 && nextMessages.length < prevMessages.length) {
    divergedAtIndex = nextMessages.length;
  }

  let invalidatedTokens = 0;
  if (divergedAtIndex !== -1) {
    for (let i = divergedAtIndex; i < prevMessages.length; i += 1) {
      invalidatedTokens += estimateTokens(prevMessages[i]);
    }
  }

  return {
    prefixIntact: divergedAtIndex === -1,
    toolsChanged: false,
    divergedAtIndex,
    preservedTokens,
    invalidatedTokens,
    reason: divergedAtIndex === -1 ? 'prefix_preserved' : `history_mutated_at_${divergedAtIndex}`,
  };
}

/**
 * Evaluate net economic impact of an optimization step.
 * Distinguishes `observed` (from real provider cache fields) vs `estimated`.
 */
export function evaluateOptimizationEconomics({
  baselineUsage,
  optimizedUsage,
  overheadCost = 0,
  rebuildPenaltyTokens = 0,
  model = 'deepseek-chat',
  provider = 'deepseek',
  at = Date.now(),
  table = DEFAULT_PRICE_TABLE,
  observed = false,
} = {}) {
  const basePriced = priceUsage(baselineUsage, { model, at, table });
  const optPriced = priceUsage(optimizedUsage, { model, at, table });
  const rates = ratesAt(model, at, table);
  const profile = getCacheProfile(provider);

  const safeOverhead = Math.max(0, Number(overheadCost) || 0);
  // If prefix cache was broken, invalidated tokens get re-billed at miss - hit delta on next step
  const missMinusHitRate = Math.max(0, rates.cacheMiss - rates.cacheHit) / 1_000_000;
  const rebuildCost = Math.max(0, Number(rebuildPenaltyTokens) || 0) * missMinusHitRate;

  const baselineCost = basePriced.cost.total;
  const optimizedApiCost = optPriced.cost.total;
  const optimizedTotalCost = optimizedApiCost + safeOverhead + rebuildCost;
  const netSavings = baselineCost - optimizedTotalCost;
  const savingsPct = baselineCost > 0 ? (netSavings / baselineCost) * 100 : 0;

  const baseInput = inputTokensOf(basePriced.buckets);
  const optInput = inputTokensOf(optPriced.buckets);

  return {
    dataSource: observed ? 'observed' : 'estimated',
    model,
    provider,
    cacheMechanism: profile.mechanism,
    currency: table.currency,
    symbol: table.symbol,
    baselineCost,
    optimizedApiCost,
    overheadCost: safeOverhead,
    rebuildCost,
    optimizedTotalCost,
    netSavings,
    savingsPct,
    tokenDelta: baseInput - optInput,
    shouldFallback: netSavings < 0,
    baselineBuckets: normalizeUsage(baselineUsage),
    optimizedBuckets: normalizeUsage(optimizedUsage),
  };
}

/**
 * Pre-flight cost gate: decides whether a lossy rewrite/compression that breaks prefix cache
 * is economically worthwhile over `expectedRemainingTurns`.
 */
export function shouldRewritePrefix({
  tokensSaved = 0,
  invalidatedPrefixTokens = 0,
  expectedRemainingTurns = 1,
  compressionOverheadCost = 0,
  model = 'deepseek-chat',
  at = Date.now(),
  table = DEFAULT_PRICE_TABLE,
} = {}) {
  const rates = ratesAt(model, at, table);
  const turns = Math.max(1, Number(expectedRemainingTurns) || 1);
  // Saving tokens once avoids 1x cacheMiss + (turns - 1)x cacheHit
  const grossSavings = (Math.max(0, tokensSaved) / 1_000_000)
    * (rates.cacheMiss + (turns - 1) * rates.cacheHit);
  // Invalidating prefix converts cached hits into cold cacheMiss on next turn
  const cacheRebuildPenalty = (Math.max(0, invalidatedPrefixTokens) / 1_000_000)
    * Math.max(0, rates.cacheMiss - rates.cacheHit);
  const netExpectedSavings = grossSavings - cacheRebuildPenalty - Math.max(0, compressionOverheadCost);
  return {
    worthwhile: netExpectedSavings > 0,
    grossSavings,
    cacheRebuildPenalty,
    netExpectedSavings,
  };
}
