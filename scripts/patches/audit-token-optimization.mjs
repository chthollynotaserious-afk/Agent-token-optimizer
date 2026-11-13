#!/usr/bin/env node
// Denia Token 优化专项：只读归因审计（不调用模型、不改遥测格式）。
//
// 数据源：
//   state/context-telemetry-bridge.jsonl   桥接侧：wake / model_call / tool_call / tool_result（带 key、wakeId）
//   state/tool-calls.jsonl                 工具参数（用于重复调用检测）
//   state/sessions.json                    会话 key ↔ sessionId
//   <DSH_HOME>/surfcore/context-telemetry-plugin.jsonl 插件侧（用于交叉核对调用数）
//
// 输出 JSON + Markdown。所有费用按 src/model-prices.js 峰谷价估算。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { priceUsage, DEFAULT_PRICE_TABLE } from '../src/model-prices.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const STATE_DIR = process.env.DENIA_STATE_DIR || path.join(ROOT, 'state');
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const args = process.argv.slice(2);
const hours = Math.max(1, Number(args[args.indexOf('--hours') + 1]) || 24);
const since = Date.now() - hours * 3600_000;
const outJson = args.includes('--json');

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  const rows = [];
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line) continue;
    try { rows.push(JSON.parse(line)); } catch { /* ignore */ }
  }
  return rows;
}

const bridge = readJsonl(path.join(STATE_DIR, 'context-telemetry-bridge.jsonl'));
const toolLog = readJsonl(path.join(STATE_DIR, 'tool-calls.jsonl'));
const plugin = readJsonl(path.join(DSH_HOME, 'surfcore', 'context-telemetry-plugin.jsonl'));

const inWin = (r) => Number(r.ts) >= since;
const wakeRows = bridge.filter((r) => r.kind === 'wake' && inWin(r));
const calls = bridge.filter((r) => r.kind === 'model_call' && inWin(r) && (r.phase ?? 'message') === 'message');
const pluginCalls = plugin.filter((r) => r.kind === 'model_call' && inWin(r) && (r.phase ?? 'message') === 'message');
const toolCalls = bridge.filter((r) => r.kind === 'tool_call' && inWin(r));
const toolResults = bridge.filter((r) => r.kind === 'tool_result' && inWin(r));

const money = (n) => Math.round((Number(n) || 0) * 1e6) / 1e6;
const pct = (n, d) => `${((Number(n) || 0) / Math.max(1, d) * 100).toFixed(1)}%`;
const sum = (arr, f) => arr.reduce((a, x) => a + (Number(f(x)) || 0), 0);

// ── 费用拆分 ───────────────────────────────────────────────────────────────
function costParts(u, model, at) {
  const priced = priceUsage({
    cacheMiss: u.cacheMiss ?? 0, cacheHit: u.cacheHit ?? 0, cacheWrite: u.cacheWrite ?? 0,
    output: u.output ?? 0, reasoning: u.reasoning ?? 0,
  }, { model, at, table: DEFAULT_PRICE_TABLE });
  // 单项成本：用只含单个桶的调用反推，避免依赖价目表内部结构。
  const one = (bucket) => priceUsage({ [bucket]: u[bucket] ?? 0 }, { model, at, table: DEFAULT_PRICE_TABLE }).cost.total;
  return {
    total: priced.cost.total,
    cacheHit: one('cacheHit'),
    cacheMiss: one('cacheMiss'),
    cacheWrite: one('cacheWrite'),
    output: one('output') + one('reasoning'),
  };
}

const totals = { calls: calls.length, input: 0, cacheHit: 0, cacheMiss: 0, cacheWrite: 0, output: 0, cost: 0, costHit: 0, costMiss: 0, costOut: 0, retry: 0, zeroOutput: 0 };
for (const c of calls) {
  const u = c.usage ?? {};
  const p = costParts(u, c.model, c.ts);
  totals.input += (u.cacheMiss ?? 0) + (u.cacheHit ?? 0) + (u.cacheWrite ?? 0);
  totals.cacheHit += u.cacheHit ?? 0;
  totals.cacheMiss += u.cacheMiss ?? 0;
  totals.cacheWrite += u.cacheWrite ?? 0;
  totals.output += u.output ?? 0;
  totals.cost += p.total;
  totals.costHit += p.cacheHit;
  totals.costMiss += p.cacheMiss;
  totals.costOut += p.output;
  if (Number(c.retry) > 0) totals.retry += 1;
  if (!(Number(u.output) > 0)) totals.zeroOutput += 1;
}

// ── 按唤醒归因（bridge 的 model_call 自带 wakeId）────────────────────────────
const wakeById = new Map(wakeRows.map((w) => [w.wakeId, w]));
const byWake = new Map();
for (const c of calls) {
  const id = c.wakeId || '';
  if (!id) continue;
  const w = wakeById.get(id);
  const u = c.usage ?? {};
  const p = costParts(u, c.model, c.ts);
  const e = byWake.get(id) ?? {
    wakeId: id, key: c.key || w?.key || '', reason: w?.reason || 'unknown',
    calls: 0, input: 0, output: 0, cost: 0, tools: 0, promptChars: Number(w?.promptChars) || 0,
  };
  e.calls += 1; e.input += (u.cacheMiss ?? 0) + (u.cacheHit ?? 0) + (u.cacheWrite ?? 0);
  e.output += u.output ?? 0; e.cost += p.total;
  byWake.set(id, e);
}
const toolCallByWake = new Map();
for (const t of toolCalls) if (t.wakeId) toolCallByWake.set(t.wakeId, (toolCallByWake.get(t.wakeId) || 0) + 1);
for (const [id, e] of byWake) e.tools = toolCallByWake.get(id) || 0;

const reasonAgg = new Map();
for (const w of wakeRows) {
  const e = reasonAgg.get(w.reason) ?? { reason: w.reason, wakes: 0, calls: 0, input: 0, output: 0, cost: 0, tools: 0, promptChars: 0 };
  e.wakes += 1; e.promptChars += Number(w.promptChars) || 0;
  reasonAgg.set(w.reason, e);
}
for (const e of byWake.values()) {
  const r = reasonAgg.get(e.reason);
  if (!r) continue;
  r.calls += e.calls; r.input += e.input; r.output += e.output; r.cost += e.cost; r.tools += e.tools;
}
const freeWakes = wakeRows.length - byWake.size;

// ── 按会话 ─────────────────────────────────────────────────────────────────
const byKey = new Map();
for (const c of calls) {
  const key = c.key || 'unknown';
  const u = c.usage ?? {};
  const p = costParts(u, c.model, c.ts);
  const e = byKey.get(key) ?? { key, calls: 0, input: 0, output: 0, cost: 0, turns: new Set(), wakes: 0, tools: 0 };
  e.calls += 1; e.input += (u.cacheMiss ?? 0) + (u.cacheHit ?? 0) + (u.cacheWrite ?? 0);
  e.output += u.output ?? 0; e.cost += p.total; e.turns.add(c.turn);
  byKey.set(key, e);
}
for (const w of wakeRows) {
  const e = byKey.get(w.key);
  if (e) e.wakes += 1;
}
for (const t of toolCalls) {
  const e = byKey.get(t.key);
  if (e) e.tools += 1;
}

// ── 按轮：调用数、工具、是否有出站动作 ──────────────────────────────────────
const OUTBOUND = /qq_send|qq_reply|qq_send_voice|qq_send_sticker|qq_send_poke|owner_send/;
const turnMap = new Map();
const turnKey = (r) => `${r.sessionId}|${r.turn}`;
for (const c of calls) {
  const k = turnKey(c);
  const u = c.usage ?? {};
  const e = turnMap.get(k) ?? { key: c.key || '', sessionId: c.sessionId, turn: c.turn, calls: 0, input: 0, output: 0, cost: 0, tools: 0, outbound: 0, outboundOk: 0 };
  e.calls += 1; e.input += (u.cacheMiss ?? 0) + (u.cacheHit ?? 0) + (u.cacheWrite ?? 0);
  e.output += u.output ?? 0; e.cost += costParts(u, c.model, c.ts).total;
  turnMap.set(k, e);
}
for (const t of toolCalls) {
  const e = turnMap.get(turnKey(t));
  if (!e) continue;
  e.tools += 1;
  if (OUTBOUND.test(String(t.tool))) e.outbound += 1;
}
for (const r of toolResults) {
  const e = turnMap.get(turnKey(r));
  if (!e) continue;
  if (OUTBOUND.test(String(r.tool)) && r.ok !== false) e.outboundOk += 1;
}
const turns = [...turnMap.values()];
const noOutbound = turns.filter((t) => t.outboundOk === 0);
const noOutboundCost = sum(noOutbound, (t) => t.cost);

// ── 工具链与重复 ───────────────────────────────────────────────────────────
const toolStats = new Map();
for (const t of toolCalls) {
  const e = toolStats.get(t.tool) ?? { tool: t.tool, calls: 0, resultChars: 0, errors: 0, repeatsSameArgs: 0 };
  e.calls += 1;
  toolStats.set(t.tool, e);
}
for (const r of toolResults) {
  const e = toolStats.get(r.tool);
  if (!e) continue;
  e.resultChars += Number(r.resultChars) || 0;
  if (r.ok === false) e.errors += 1;
}

const transitions = new Map();
const orderedByTurn = new Map();
for (const t of toolCalls) {
  const k = turnKey(t);
  if (!orderedByTurn.has(k)) orderedByTurn.set(k, []);
  orderedByTurn.get(k).push(t);
}
for (const list of orderedByTurn.values()) {
  list.sort((a, b) => Number(a.ts) - Number(b.ts));
  for (let i = 1; i < list.length; i += 1) {
    const k = `${list[i - 1].tool} → ${list[i].tool}`;
    transitions.set(k, (transitions.get(k) || 0) + 1);
  }
}

// 重复同一工具 + 同一参数：同会话 5 分钟内。tool-calls.jsonl 带 args。
const lastCall = new Map();
let repeatSameArgs = 0;
const repeatSamples = [];
const repeatsByTool = new Map();
for (const t of toolLog) {
  if (t.type !== 'call') continue;
  const ts = Date.parse(t.time);
  if (!Number.isFinite(ts) || ts < since) continue;
  const argsText = String(t.args ?? '');
  if (!argsText) continue;
  const k = `${t.key}|${t.tool}|${argsText}`;
  const prev = lastCall.get(k) ?? 0;
  if (prev && ts - prev <= 5 * 60_000) {
    repeatSameArgs += 1;
    repeatsByTool.set(t.tool, (repeatsByTool.get(t.tool) || 0) + 1);
    if (repeatSamples.length < 20) repeatSamples.push({ tool: t.tool, key: t.key, gapMs: ts - prev, at: t.time });
  }
  lastCall.set(k, ts);
}

// ── 工具结果 → 下一次模型调用：整次调用的输入与费用（不是增量）──────────────
// 回答「这个工具触发了多少模型推理」。同一批并行结果共享同一次下一次调用时按数量均分。
const nextCallsByTool = new Map();
const callsByTurn = new Map();
for (const c of calls) {
  const k = `${c.sessionId}|${c.turn}`;
  if (!callsByTurn.has(k)) callsByTurn.set(k, []);
  callsByTurn.get(k).push(c);
}
for (const arr of callsByTurn.values()) arr.sort((a, b) => Number(a.ts) - Number(b.ts));
for (const r of toolResults) {
  const arr = callsByTurn.get(`${r.sessionId}|${r.turn}`) ?? [];
  const next = arr.find((c) => Number(c.ts) >= Number(r.ts));
  if (!next) continue;
  const batch = toolResults.filter((x) => x.sessionId === r.sessionId && x.turn === r.turn
    && Math.abs(Number(x.ts) - Number(r.ts)) <= 100);
  const share = 1 / Math.max(1, batch.length);
  const u = next.usage ?? {};
  const input = (u.cacheMiss ?? 0) + (u.cacheHit ?? 0) + (u.cacheWrite ?? 0);
  const cost = costParts(u, next.model, next.ts).total;
  const e = nextCallsByTool.get(r.tool) ?? { tool: r.tool, linked: 0, input: 0, cost: 0, seen: new Set() };
  e.linked += 1;
  const id = `${next.sessionId}|${next.turn}|${next.step}`;
  if (!e.seen.has(id)) {
    e.seen.add(id);
    e.input += input * share;
    e.cost += cost * share;
  }
  nextCallsByTool.set(r.tool, e);
}
for (const e of nextCallsByTool.values()) delete e.seen;

// ── 唤醒间隔与消息合并模拟 ─────────────────────────────────────────────────
const wakeGaps = [];
for (const key of new Set(wakeRows.map((w) => w.key))) {
  const list = wakeRows.filter((w) => w.key === key).map((w) => Number(w.ts)).sort((a, b) => a - b);
  for (let i = 1; i < list.length; i += 1) wakeGaps.push(list[i] - list[i - 1]);
}
const gapBuckets = [[0, 8000], [8000, 10000], [10000, 12000], [12000, 15000], [15000, 30000], [30000, 60000], [60000, Infinity]]
  .map(([lo, hi]) => ({ lo, hi: hi === Infinity ? null : hi, count: wakeGaps.filter((g) => g >= lo && g < hi).length }));

const history = readJsonl(path.join(STATE_DIR, 'message-history.jsonl'));
function simulateBatching(windowMs) {
  const byConv = new Map();
  for (const m of history) {
    if (m.direction !== 'in' || !m.conversationKey) continue;
    const ts = Number(m.ts);
    if (!Number.isFinite(ts) || ts < since) continue;
    if (!byConv.has(m.conversationKey)) byConv.set(m.conversationKey, []);
    byConv.get(m.conversationKey).push(ts);
  }
  let batches = 0;
  let messages = 0;
  let maxBatch = 0;
  for (const list of byConv.values()) {
    list.sort((a, b) => a - b);
    messages += list.length;
    let current = 0;
    let last = -Infinity;
    for (const ts of list) {
      if (ts - last > windowMs) {
        if (current) batches += 1;
        current = 0;
      }
      current += 1;
      maxBatch = Math.max(maxBatch, current);
      last = ts;
    }
    if (current) batches += 1;
  }
  return { windowMs, inboundMessages: messages, batches, avgMessagesPerBatch: messages / Math.max(1, batches), maxBatch };
}
const batching = [8000, 10000, 12000, 15000].map(simulateBatching);

// ── 响应延迟（实测回放，不是预测）──────────────────────────────────────────
// 从「唤醒投递」到「首个成功出站工具结果」；没有出站的唤醒不计入均值，单独计数。
// 唤醒前的最老未读年龄由桥接在 layers.oldestUnreadAgeMs 里给出，可拆出合并等待。
const outboundFirstByWake = new Map();
for (const r of toolResults) {
  if (!r.wakeId || !OUTBOUND.test(String(r.tool)) || r.ok === false) continue;
  const prev = outboundFirstByWake.get(r.wakeId);
  if (!prev || Number(r.ts) < Number(prev.ts)) outboundFirstByWake.set(r.wakeId, r);
}
const latencyRows = [];
for (const w of wakeRows) {
  const out = outboundFirstByWake.get(w.wakeId);
  if (!out) continue;
  const ms = Number(out.ts) - Number(w.ts);
  if (Number.isFinite(ms) && ms >= 0) latencyRows.push({ ms, reason: w.reason || 'unknown', key: w.key || '' });
}
const quantile = (arr, q) => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.floor((s.length - 1) * q)))];
};
const latencySummary = (rows) => {
  const xs = rows.map((x) => x.ms);
  return {
    wakes: rows.length,
    avgMs: xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : 0,
    p50Ms: quantile(xs, 0.5),
    p90Ms: quantile(xs, 0.9),
  };
};
const latencyByReason = new Map();
for (const row of latencyRows) {
  if (!latencyByReason.has(row.reason)) latencyByReason.set(row.reason, []);
  latencyByReason.get(row.reason).push(row);
}
const wakeAgeMs = wakeRows
  .map((w) => Number(w.layers?.oldestUnreadAgeMs))
  .filter((n) => Number.isFinite(n) && n >= 0);
const latency = {
  method: 'wake-to-first-successful-outbound',
  measured: true,
  wakesWithOutbound: latencyRows.length,
  wakesWithoutOutbound: wakeRows.length - latencyRows.length,
  overall: latencySummary(latencyRows),
  byReason: [...latencyByReason].map(([reason, rows]) => ({ reason, ...latencySummary(rows) }))
    .sort((a, b) => b.wakes - a.wakes),
  wakeAge: {
    samples: wakeAgeMs.length,
    avgMs: wakeAgeMs.length ? Math.round(wakeAgeMs.reduce((a, b) => a + b, 0) / wakeAgeMs.length) : 0,
    p50Ms: quantile(wakeAgeMs, 0.5),
    p90Ms: quantile(wakeAgeMs, 0.9),
  },
};

// 无出站动作的轮，按唤醒原因归类（需要 wakeId → reason；轮内第一条调用带 wakeId）。
const turnReason = new Map();
for (const c of calls) {
  const k = turnKey(c);
  if (!turnReason.has(k) && c.wakeId) turnReason.set(k, wakeById.get(c.wakeId)?.reason || 'unknown');
}
const noOutboundByReason = new Map();
for (const t of noOutbound) {
  const r = turnReason.get(`${t.sessionId}|${t.turn}`) || 'unknown';
  const e = noOutboundByReason.get(r) ?? { reason: r, turns: 0, cost: 0 };
  e.turns += 1; e.cost += t.cost;
  noOutboundByReason.set(r, e);
}

// ── 唤醒提示词层 ───────────────────────────────────────────────────────────
const layerTotal = new Map();
for (const w of wakeRows) for (const [k, v] of Object.entries(w.layers || {})) {
  if (!Number.isFinite(Number(v))) continue;
  layerTotal.set(k, (layerTotal.get(k) || 0) + Number(v));
}

// ── 部署后窗口（DSH 15:05 重启）────────────────────────────────────────────
// 本机时区为 UTC（Get-Date 输出 +00:00），遥测 ts 也是 UTC 毫秒；部署 15:05 本地 = 15:05Z。
const DEPLOY_TS = Date.parse('2026-11-05T15:06:00Z');
const postCalls = calls.filter((c) => Number(c.ts) >= DEPLOY_TS);
const preCalls = calls.filter((c) => Number(c.ts) < DEPLOY_TS);
const avgInput = (arr) => arr.length ? sum(arr, (c) => (c.usage?.cacheMiss ?? 0) + (c.usage?.cacheHit ?? 0) + (c.usage?.cacheWrite ?? 0)) / arr.length : 0;
const avgCost = (arr) => arr.length ? sum(arr, (c) => costParts(c.usage ?? {}, c.model, c.ts).total) / arr.length : 0;

const report = {
  generatedAt: new Date().toISOString(),
  windowHours: hours,
  sources: {
    bridgeRows: bridge.length, wakeRows: wakeRows.length,
    bridgeCalls: calls.length, pluginCalls: pluginCalls.length,
    toolCalls: toolCalls.length, toolResults: toolResults.length,
  },
  totals: {
    ...totals,
    hitRate: totals.cacheHit / Math.max(1, totals.input),
    perCallInput: totals.input / Math.max(1, totals.calls),
    perCallOutput: totals.output / Math.max(1, totals.calls),
    perWakeInput: totals.input / Math.max(1, wakeRows.length),
    perWakeCost: totals.cost / Math.max(1, wakeRows.length),
    perWakeCalls: totals.calls / Math.max(1, wakeRows.length),
    freeWakes,
  },
  byReason: [...reasonAgg.values()].sort((a, b) => b.cost - a.cost),
  byKey: [...byKey.values()].map((e) => ({ ...e, turns: e.turns.size })).sort((a, b) => b.cost - a.cost),
  turns: {
    count: turns.length,
    noOutbound: noOutbound.length,
    noOutboundCost: money(noOutboundCost),
    emptyWakes: [...byWake.values()].filter((e) => e.tools === 0 && e.calls > 0).length,
    distribution: [1, 2, 3, 5, 8, 12, 20].map((n) => ({ atLeast: n, count: turns.filter((t) => t.calls >= n).length })),
    top: turns.sort((a, b) => b.cost - a.cost).slice(0, 15),
  },
  tools: [...toolStats.values()].sort((a, b) => b.calls - a.calls),
  transitions: [...transitions].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([edge, count]) => ({ edge, count })),
  nextCallsByTool: [...nextCallsByTool.values()].map((e) => ({ ...e, input: Math.round(e.input), cost: money(e.cost) })).sort((a, b) => b.cost - a.cost),
  repeatSameArgs: { count: repeatSameArgs, byTool: [...repeatsByTool].sort((a, b) => b[1] - a[1]).map(([tool, count]) => ({ tool, count })), samples: repeatSamples },
  noOutboundByReason: [...noOutboundByReason.values()].sort((a, b) => b.cost - a.cost),
  wakeGaps: { buckets: gapBuckets, median: wakeGaps.sort((a, b) => a - b)[Math.floor(wakeGaps.length / 2)] ?? 0 },
  batching,
  latency,
  wakePrompt: {
    avgChars: sum(wakeRows, (w) => w.promptChars) / Math.max(1, wakeRows.length),
    layers: [...layerTotal].filter(([k]) => !['prompt', 'unreadCount', 'historyCount', 'ownerCount', 'unreadMediaCount', 'recentCount', 'oldestUnreadAgeMs', 'media'].includes(k))
      .sort((a, b) => b[1] - a[1]).map(([layer, chars]) => ({ layer, chars, perWake: Math.round(chars / Math.max(1, wakeRows.length)) })),
  },
  deployCompare: {
    deployAt: new Date(DEPLOY_TS).toISOString(),
    pre: { calls: preCalls.length, avgInput: Math.round(avgInput(preCalls)), avgCost: money(avgCost(preCalls)) },
    post: { calls: postCalls.length, avgInput: Math.round(avgInput(postCalls)), avgCost: money(avgCost(postCalls)) },
  },
};

if (outJson) { console.log(JSON.stringify(report, null, 2)); process.exit(0); }

const L = [];
const f = (n) => Math.round(Number(n) || 0).toLocaleString();
L.push(`# Denia Token 优化审计（最近 ${hours} 小时）`);
L.push('');
L.push(`生成：${report.generatedAt}`);
L.push(`数据：bridge wake ${wakeRows.length} / model_call ${calls.length}（插件侧 ${pluginCalls.length}）/ tool_call ${toolCalls.length} / tool_result ${toolResults.length}`);
L.push('');
L.push('## 总览');
L.push('| 指标 | 值 |');
L.push('|---|---:|');
L.push(`| 模型调用 | ${f(totals.calls)} |`);
L.push(`| 唤醒 | ${f(wakeRows.length)}（其中 ${freeWakes} 次未产生模型调用） |`);
L.push(`| 每次唤醒模型调用 | ${report.totals.perWakeCalls.toFixed(2)} |`);
L.push(`| 输入 token | ${f(totals.input)} |`);
L.push(`| 缓存命中 | ${f(totals.cacheHit)}（${pct(totals.cacheHit, totals.input)}） |`);
L.push(`| 缓存未命中+写入 | ${f(totals.cacheMiss + totals.cacheWrite)} |`);
L.push(`| 输出 token | ${f(totals.output)} |`);
L.push(`| 估算费用 | ¥${totals.cost.toFixed(3)} |`);
L.push(`| 其中缓存命中读取 | ¥${totals.costHit.toFixed(3)} |`);
L.push(`| 其中未命中输入 | ¥${totals.costMiss.toFixed(3)} |`);
L.push(`| 其中输出 | ¥${totals.costOut.toFixed(3)} |`);
L.push(`| 单次平均输入 | ${f(report.totals.perCallInput)} |`);
L.push(`| 重试 | ${totals.retry} |`);
L.push(`| 零输出调用 | ${totals.zeroOutput} |`);
L.push('');
L.push('## 按唤醒原因');
L.push('| 原因 | 唤醒 | 模型调用 | 输入 | 输出 | 工具 | 费用 |');
L.push('|---|---:|---:|---:|---:|---:|---:|');
for (const r of report.byReason) L.push(`| ${r.reason} | ${r.wakes} | ${r.calls} | ${f(r.input)} | ${f(r.output)} | ${r.tools} | ¥${r.cost.toFixed(3)} |`);
L.push('');
L.push('## 按会话（key）');
L.push('| 会话 | 唤醒 | 调用 | 轮 | 工具 | 输入 | 输出 | 费用 |');
L.push('|---|---:|---:|---:|---:|---:|---:|---:|');
for (const e of report.byKey) L.push(`| ${e.key} | ${e.wakes} | ${e.calls} | ${e.turns} | ${e.tools} | ${f(e.input)} | ${f(e.output)} | ¥${e.cost.toFixed(3)} |`);
L.push('');
L.push('## 轮次');
L.push(`- 轮数：${turns.length}；无成功出站动作的轮：${noOutbound.length}（费用 ¥${noOutboundCost.toFixed(3)}）`);
L.push(`- 调用数分布：${report.turns.distribution.map((d) => `≥${d.atLeast}: ${d.count}`).join('，')}`);
L.push('');
L.push('| 会话 | 轮 | 调用 | 工具 | 出站 | 输入 | 输出 | 费用 |');
L.push('|---|---:|---:|---:|---:|---:|---:|---:|');
for (const t of report.turns.top) L.push(`| ${t.key} | ${t.turn} | ${t.calls} | ${t.tools} | ${t.outboundOk} | ${f(t.input)} | ${f(t.output)} | ¥${t.cost.toFixed(3)} |`);
L.push('');
L.push('## 工具');
L.push('| 工具 | 调用 | 返回字符 | 错误 |');
L.push('|---|---:|---:|---:|');
for (const t of report.tools.slice(0, 30)) L.push(`| ${t.tool} | ${t.calls} | ${f(t.resultChars)} | ${t.errors} |`);
L.push('');
L.push('## 工具转移 Top 20');
L.push('| 转移 | 次数 |');
L.push('|---|---:|');
for (const t of report.transitions) L.push(`| ${t.edge} | ${t.count} |`);
L.push('');
L.push('## 工具触发的下一次模型调用（整次输入，估算）');
L.push('| 工具 | 关联结果 | 下一次调用输入 | 费用 |');
L.push('|---|---:|---:|---:|');
for (const t of report.nextCallsByTool.slice(0, 15)) L.push(`| ${t.tool} | ${t.linked} | ${f(t.input)} | ¥${t.cost.toFixed(3)} |`);
L.push('');
L.push(`## 重复调用（同 key + 同工具 + 同参数，5 分钟内）：${repeatSameArgs} 次`);
L.push(`按工具：${report.repeatSameArgs.byTool.map((x) => `${x.tool} ${x.count}`).join('，') || '无'}`);
for (const s of repeatSamples) L.push(`- ${s.at} ${s.key} ${s.tool}（间隔 ${Math.round(s.gapMs / 1000)}s）`);
L.push('');
L.push('## 无成功出站动作的轮，按原因');
L.push('| 原因 | 轮 | 费用 |');
L.push('|---|---:|---:|');
for (const r of report.noOutboundByReason) L.push(`| ${r.reason} | ${r.turns} | ¥${r.cost.toFixed(3)} |`);
L.push('');
L.push('## 响应延迟（实测回放）');
L.push(`- 唤醒→首个成功出站：${latency.wakesWithOutbound} 次；平均 ${(latency.overall.avgMs / 1000).toFixed(1)}s，中位 ${(latency.overall.p50Ms / 1000).toFixed(1)}s，P90 ${(latency.overall.p90Ms / 1000).toFixed(1)}s`);
L.push(`- 无成功出站的唤醒：${latency.wakesWithoutOutbound} 次（不参与延迟均值）`);
L.push(`- 唤醒时未读最老消息年龄：中位 ${(latency.wakeAge.p50Ms / 1000).toFixed(1)}s，P90 ${(latency.wakeAge.p90Ms / 1000).toFixed(1)}s（含合并/排队等待）`);
L.push('');
L.push('| 原因 | 有出站唤醒 | 平均 | 中位 | P90 |');
L.push('|---|---:|---:|---:|---:|');
for (const r of latency.byReason) L.push(`| ${r.reason} | ${r.wakes} | ${(r.avgMs / 1000).toFixed(1)}s | ${(r.p50Ms / 1000).toFixed(1)}s | ${(r.p90Ms / 1000).toFixed(1)}s |`);
L.push('');
L.push('## 唤醒间隔（同会话相邻唤醒）');
L.push(`中位数 ${Math.round(report.wakeGaps.median / 1000)}s；${report.wakeGaps.buckets.map((b) => `${b.lo / 1000}-${b.hi ? b.hi / 1000 : '∞'}s: ${b.count}`).join('，')}`);
L.push('');
L.push('## 消息合并窗口回放（用 message-history 入站时间戳模拟）');
L.push('| 窗口 | 入站消息 | 合并后批次数 | 每批平均消息 | 最大批 |');
L.push('|---|---:|---:|---:|---:|');
for (const b of report.batching) L.push(`| ${b.windowMs / 1000}s | ${b.inboundMessages} | ${b.batches} | ${b.avgMessagesPerBatch.toFixed(2)} | ${b.maxBatch} |`);
L.push('');
L.push('## 唤醒提示词层（每唤醒平均字符）');
L.push('| 层 | 总字符 | 每唤醒 |');
L.push('|---|---:|---:|');
for (const l of report.wakePrompt.layers.slice(0, 25)) L.push(`| ${l.layer} | ${f(l.chars)} | ${l.perWake} |`);
L.push('');
L.push('## 部署前后对比（DSH 15:05 重启）');
L.push('| 窗口 | 调用 | 单次平均输入 | 单次平均费用 |');
L.push('|---|---:|---:|---:|');
L.push(`| 部署前 | ${preCalls.length} | ${f(report.deployCompare.pre.avgInput)} | ¥${report.deployCompare.pre.avgCost} |`);
L.push(`| 部署后 | ${postCalls.length} | ${f(report.deployCompare.post.avgInput)} | ¥${report.deployCompare.post.avgCost} |`);
L.push('');
L.push(`> 口径提醒：部署后只有 ${postCalls.length} 次调用，且样本尚未完整经历 0.22 阈值（约 230,686 token）后的压缩周期；重启同时带来会话恢复与缓存冷启动。此表的差异**不能直接归因于压缩配置**，需要 24–48h 复测。`);
L.push('');
console.log(L.join('\n'));
