import fs from 'node:fs';

const BRIDGE_PATH = '/home/ubuntu/surfcore/src/bridge.js';

function backupOnce(filePath, suffix) {
  const bak = `${filePath}${suffix}`;
  if (!fs.existsSync(bak) && fs.existsSync(filePath)) {
    fs.copyFileSync(filePath, bak);
    console.log(`Backup created: ${bak}`);
  }
}

function replaceExact(src, target, replacement, label) {
  const idx = src.indexOf(target);
  if (idx === -1) throw new Error(`Target not found for [${label}]`);
  if (src.indexOf(target, idx + 1) !== -1) throw new Error(`Target matched multiple times for [${label}]`);
  return src.slice(0, idx) + replacement + src.slice(idx + target.length);
}

backupOnce(BRIDGE_PATH, '.bak-before-cost-fix');
let bridge = fs.readFileSync(BRIDGE_PATH, 'utf8');

// 1. Import priceUsage & inputTokensOf from ./model-prices.js
if (!bridge.includes('import { resolvePriceTable, normalizeUsage, priceUsage, inputTokensOf } from \'./model-prices.js\';')) {
  bridge = replaceExact(
    bridge,
    `import { resolvePriceTable, normalizeUsage } from './model-prices.js';`,
    `import { resolvePriceTable, normalizeUsage, priceUsage, inputTokensOf } from './model-prices.js';`,
    'model-prices import',
  );
  console.log('1/3 Updated model-prices import');
}

// 2. Replace queryRecentCostSummary() with official priceUsage + token-usage.jsonl (fallback telemetry)
bridge = replaceExact(
  bridge,
  `// ── 高精费用实测口径（供 /cost 命令实时查询上一个小时与今日计费） ───────────
function queryRecentCostSummary() {
  const telemetryFile = path.join(STATE_DIR, 'context-telemetry-bridge.jsonl');
  if (!fs.existsSync(telemetryFile)) return null;

  const now = Date.now();
  const oneHourAgo = now - 3600 * 1000;
  const startOfToday = new Date().setHours(0, 0, 0, 0);

  let h1Calls = 0, h1Miss = 0, h1Hit = 0, h1Out = 0, h1Cost = 0;
  let dayCalls = 0, dayCost = 0;

  function calcCallCost(usage, ts) {
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

  try {
    const content = fs.readFileSync(telemetryFile, 'utf8');
    const lines = content.trim().split('\\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!line || !line.includes('model_call')) continue;
      try {
        const item = JSON.parse(line);
        if (item.kind !== 'model_call' || !item.ts) continue;
        if (item.ts < startOfToday && item.ts < oneHourAgo) {
          if (lines.length - i > 600) break;
        }
        const cost = calcCallCost(item.usage, item.ts);
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
        costCNY: h1Cost.toFixed(2),
        miss: h1Miss,
        hit: h1Hit,
        out: h1Out,
        hitRatio: \`\${hitRatio}%\`
      },
      today: {
        calls: dayCalls,
        costCNY: dayCost.toFixed(2)
      }
    };
  } catch (err) {
    log(\`[cost-query] 统计失败：\${err?.message || err}\`);
    return null;
  }
}`,
  `// ── 高精费用实测口径（供 /cost 命令实时查询上一个小时与今日计费） ───────────
// 统一复用 model-prices.js 的官方价目表（deepseek-flash 命中 0.02/0.04、未命中 1/2、输出 4/8，
// 并按北京时间工作日 09:00-12:00 / 14:00-18:00 判高峰），对齐 DeepSeek 后台 UTC 自然日统计。
function queryRecentCostSummary() {
  const usageFile = typeof TOKEN_USAGE_FILE === 'string'
    ? TOKEN_USAGE_FILE
    : path.join(STATE_DIR, 'token-usage.jsonl');
  const telemetryFile = path.join(STATE_DIR, 'context-telemetry-bridge.jsonl');
  const useLedger = fs.existsSync(usageFile);
  const sourceFile = useLedger ? usageFile : (fs.existsSync(telemetryFile) ? telemetryFile : '');
  if (!sourceFile) return null;

  const now = Date.now();
  const nowDate = new Date(now);
  const oneHourAgo = now - 3600 * 1000;
  // DeepSeek 官方控制台日账单按 UTC 00:00 切分，用 UTC 零点可直接对齐官方账单
  const startOfUtcToday = Date.UTC(nowDate.getUTCFullYear(), nowDate.getUTCMonth(), nowDate.getUTCDate());
  const cutoff = Math.min(startOfUtcToday, oneHourAgo);
  const table = typeof priceTable !== 'undefined' ? priceTable : resolvePriceTable(cfg?.pricing);

  let h1Calls = 0, h1Miss = 0, h1Hit = 0, h1Write = 0, h1Out = 0, h1Cost = 0;
  let dayCalls = 0, dayCost = 0;

  try {
    const content = fs.readFileSync(sourceFile, 'utf8');
    const lines = content.trim().split('\\n');
    let olderStreak = 0;
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!line) continue;
      if (useLedger && !line.includes('"turn"')) continue;
      if (!useLedger && !line.includes('model_call')) continue;
      try {
        const item = JSON.parse(line);
        const ts = Number(useLedger ? item.t : item.ts);
        if (!Number.isFinite(ts) || ts <= 0) continue;
        if (useLedger && item.k !== 'turn') continue;
        if (!useLedger && item.kind !== 'model_call') continue;

        if (ts < cutoff) {
          olderStreak += 1;
          // 给 1 小时乱序容错后提前退出，避免反复扫描数周前历史
          if (ts < cutoff - 3600 * 1000 && olderStreak >= 32) break;
          continue;
        }
        olderStreak = 0;

        const buckets = normalizeUsage(useLedger ? item.b : item.usage);
        const model = String(item.model || cfg?.dsh?.model || 'deepseek-flash');
        const cost = priceUsage(buckets, { model, at: ts, table }).cost.total;

        if (ts >= startOfUtcToday) {
          dayCalls += 1;
          dayCost += cost;
        }
        if (ts >= oneHourAgo) {
          h1Calls += 1;
          h1Cost += cost;
          h1Miss += buckets.cacheMiss;
          h1Hit += buckets.cacheHit;
          h1Write += buckets.cacheWrite;
          h1Out += buckets.output;
        }
      } catch {}
    }

    const totalIn = inputTokensOf({ cacheMiss: h1Miss, cacheHit: h1Hit, cacheWrite: h1Write });
    const hitRatio = totalIn > 0 ? ((h1Hit / totalIn) * 100).toFixed(1) : '0.0';
    return {
      source: useLedger ? 'token-usage' : 'context-telemetry',
      h1: {
        calls: h1Calls,
        costCNY: h1Cost.toFixed(2),
        miss: h1Miss,
        hit: h1Hit,
        out: h1Out,
        hitRatio: \`\${hitRatio}%\`,
      },
      today: {
        calls: dayCalls,
        costCNY: dayCost.toFixed(2),
      },
    };
  } catch (err) {
    log(\`[cost-query] 统计失败：\${err?.message || err}\`);
    return null;
  }
}`,
  'queryRecentCostSummary official pricing fix',
);
console.log('2/3 Patched queryRecentCostSummary()');

// 3. Make /cost output clearly label UTC日账单 alignment
bridge = replaceExact(
  bridge,
  `          return \`📊 模型计费实测消耗：\\n\` +
            \`• 上一个小时（过去60m）：约 ¥\${summary.h1.costCNY}（\${summary.h1.calls}次调用，命中率 \${summary.h1.hitRatio}，未命中 \${Math.round(summary.h1.miss/1000)}k / 命中 \${(summary.h1.hit/1000000).toFixed(2)}M / 输出 \${Math.round(summary.h1.out/1000)}k）\\n\` +
            \`• 今日累计总计费：约 ¥\${summary.today.costCNY}（\${summary.today.calls}次调用，含主人与群聊全量）\`;`,
  `          return \`📊 模型计费实测消耗（官方分时价）：\\n\` +
            \`• 上一个小时（过去60m）：约 ¥\${summary.h1.costCNY}（\${summary.h1.calls}次调用，命中率 \${summary.h1.hitRatio}，未命中 \${Math.round(summary.h1.miss/1000)}k / 命中 \${(summary.h1.hit/1000000).toFixed(2)}M / 输出 \${Math.round(summary.h1.out/1000)}k）\\n\` +
            \`• 今日累计总计费（UTC日）：约 ¥\${summary.today.costCNY}（\${summary.today.calls}次调用，含主人私聊/群聊/后台任务；仅桥接口径）\`;`,
  '/cost reply copy',
);
console.log('3/3 Patched /cost reply copy');

fs.writeFileSync(BRIDGE_PATH, bridge, 'utf8');
console.log('Done fixing queryRecentCostSummary()');
