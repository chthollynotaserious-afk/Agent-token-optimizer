import assert from 'node:assert/strict';
import fs from 'node:fs';
import { priceUsage, normalizeUsage, resolvePriceTable, inputTokensOf } from '../src/model-prices.js';

// 1. Verify official peak/off-peak rates match DeepSeek V4.1-Flash pricing
const table = resolvePriceTable();
// 2026-11-12T10:30:00Z = 18:30 Beijing (weekday Thursday -> off-peak 1x)
const offPeakAt = Date.parse('2026-11-12T10:30:00.000Z');
// 2026-11-12T02:30:00Z = 10:30 Beijing (weekday Thursday -> peak 2x)
const peakAt = Date.parse('2026-11-12T02:30:00.000Z');

const sample = normalizeUsage({ cacheMiss: 152_000, cacheHit: 4_100_000, output: 20_000 });
const cOff = priceUsage(sample, { model: 'deepseek-flash', at: offPeakAt, table }).cost;
const cPeak = priceUsage(sample, { model: 'deepseek-flash', at: peakAt, table }).cost;

// Off-peak: 0.152*1 + 4.10*0.02 + 0.02*4 = 0.152 + 0.082 + 0.08 = 0.314
assert.ok(Math.abs(cOff.total - 0.314) < 1e-6, `Expected 0.314 off-peak, got ${cOff.total}`);
// Peak: 2x off-peak = 0.628
assert.ok(Math.abs(cPeak.total - 0.628) < 1e-6, `Expected 0.628 peak, got ${cPeak.total}`);

// 2. Verify bridge.js source wires queryRecentCostSummary to priceUsage & TOKEN_USAGE_FILE
const bridge = fs.readFileSync(new URL('../src/bridge.js', import.meta.url), 'utf8');
assert.ok(bridge.includes('priceUsage(buckets, { model, at: ts, table }).cost.total'));
assert.ok(bridge.includes("const hitRatio = totalIn > 0 ? ((h1Hit / totalIn) * 100).toFixed(1) : '0.0';"));
assert.ok(!bridge.includes('const rateHit = isOffPeak ? 0.25 : 0.5;'), 'Old 12.5x buggy rateHit must be removed');
assert.ok(!bridge.includes('const isOffPeak = hour >= 0 && hour < 8;'), 'Old inverted UTC off-peak check must be removed');

// 3. Evaluate queryRecentCostSummary against real live token-usage.jsonl if present
const liveUsage = '/srv/denia/data/state/token-usage.jsonl';
if (fs.existsSync(liveUsage)) {
  const lines = fs.readFileSync(liveUsage, 'utf8').trim().split('\n').filter(Boolean);
  const now = Date.now();
  const d = new Date(now);
  const startUtc = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const oneHourAgo = now - 3600 * 1000;
  let dayTurns = 0, dayCost = 0, h1Turns = 0, h1Cost = 0, h1Miss = 0, h1Hit = 0, h1Out = 0;
  for (const l of lines) {
    try {
      const r = JSON.parse(l);
      if (r.k !== 'turn' || !r.t) continue;
      const b = normalizeUsage(r.b);
      const cost = priceUsage(b, { model: r.model || 'deepseek-flash', at: r.t, table }).cost.total;
      if (r.t >= startUtc) { dayTurns++; dayCost += cost; }
      if (r.t >= oneHourAgo) {
        h1Turns++; h1Cost += cost;
        h1Miss += b.cacheMiss; h1Hit += b.cacheHit; h1Out += b.output;
      }
    } catch {}
  }
  const hitRatio = inputTokensOf({ cacheMiss: h1Miss, cacheHit: h1Hit, cacheWrite: 0 });
  const pct = hitRatio > 0 ? ((h1Hit / hitRatio) * 100).toFixed(1) : '0.0';
  console.log(`Live preview -> 60m: ¥${h1Cost.toFixed(2)} (${h1Turns} calls, hitRatio=${pct}%, miss=${Math.round(h1Miss / 1000)}k, hit=${(h1Hit / 1e6).toFixed(2)}M, out=${Math.round(h1Out / 1000)}k) | Today UTC: ¥${dayCost.toFixed(2)} (${dayTurns} calls)`);
}

console.log('✅ test-cost-summary passed');
