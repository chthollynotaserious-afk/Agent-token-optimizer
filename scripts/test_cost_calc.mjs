import fs from 'node:fs';

const file = '/srv/denia/data/state/context-telemetry-bridge.jsonl';
if (!fs.existsSync(file)) {
  console.log('file not found');
  process.exit(0);
}

export function queryRecentCostSummary() {
  const now = Date.now();
  const oneHourAgo = now - 3600 * 1000;
  const startOfToday = new Date().setHours(0, 0, 0, 0);

  let h1Calls = 0, h1Miss = 0, h1Hit = 0, h1Out = 0, h1Cost = 0;
  let dayCalls = 0, dayCost = 0;

  function calcCost(usage, ts) {
    const d = new Date(ts);
    const hour = d.getHours();
    const isOffPeak = hour >= 0 && hour < 8;
    const rateMiss = isOffPeak ? 1.0 : 2.0;
    const rateHit = isOffPeak ? 0.25 : 0.5;
    const rateOut = isOffPeak ? 4.0 : 8.0;

    const miss = Number(usage?.cacheMiss) || 0;
    const hit = Number(usage?.cacheHit) || 0;
    const out = (Number(usage?.output) || 0) + (Number(usage?.reasoning) || 0);

    return (miss * rateMiss + hit * rateHit + out * rateOut) / 1_000_000;
  }

  const content = fs.readFileSync(file, 'utf8');
  const lines = content.trim().split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line || !line.includes('model_call')) continue;
    try {
      const item = JSON.parse(line);
      if (item.kind !== 'model_call' || !item.ts) continue;
      if (item.ts < startOfToday && item.ts < oneHourAgo) {
        if (lines.length - i > 600) break;
      }
      const cost = calcCost(item.usage, item.ts);
      if (item.ts >= startOfToday) {
        dayCalls++;
        dayCost += cost;
      }
      if (item.ts >= oneHourAgo) {
        h1Calls++;
        h1Cost += cost;
        h1Miss += Number(item.usage?.cacheMiss) || 0;
        h1Hit += Number(item.usage?.cacheHit) || 0;
        h1Out += (Number(item.usage?.output) || 0) + (Number(item.usage?.reasoning) || 0);
      }
    } catch {}
  }

  const hitRatio = (h1Miss + h1Hit) > 0 ? ((h1Hit / (h1Miss + h1Hit)) * 100).toFixed(1) : '0.0';
  return {
    h1: {
      calls: h1Calls,
      costCNY: h1Cost.toFixed(3),
      miss: h1Miss,
      hit: h1Hit,
      out: h1Out,
      hitRatio: `${hitRatio}%`,
    },
    today: {
      calls: dayCalls,
      costCNY: dayCost.toFixed(3),
    },
  };
}

console.log(JSON.stringify(queryRecentCostSummary(), null, 2));
