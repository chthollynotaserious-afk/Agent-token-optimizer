import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

function readJsonl(p) {
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map(l => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}

function readZstdJsonl(zstdPath) {
  const out = execFileSync('zstdcat', [zstdPath], { maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' });
  return out.trim().split('\n').filter(Boolean).map(l => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}

const bridgeRows = readJsonl('/srv/denia/data/state/context-telemetry-bridge.jsonl');
const wakes = bridgeRows.filter(r => r.kind === 'wake');
const calls = bridgeRows.filter(r => r.kind === 'model_call');

// 1. Latest Private Trace (private:1587592535) and Group Trace (group:588475979)
const privWakes = wakes.filter(w => w.key === 'private:1587592535');
const grpWakes = wakes.filter(w => w.key === 'group:588475979');
const lastPrivWake = privWakes[privWakes.length - 1];
const lastGrpWake = grpWakes[grpWakes.length - 1];

console.log('=== 1. PRIVATE TRACE (latest wake + calls) ===');
console.log(JSON.stringify({
  wake: lastPrivWake,
  calls: calls.filter(c => c.wakeId === lastPrivWake?.wakeId),
}, null, 2));

console.log('=== 2. GROUP TRACE (latest wake + calls) ===');
console.log(JSON.stringify({
  wake: lastGrpWake,
  calls: calls.filter(c => c.wakeId === lastGrpWake?.wakeId),
}, null, 2));

// 2. Check layer variability across all wakes of private:1587592535 (same sessionId) and group:588475979
function analyzeLayerStability(subset, label) {
  const bySid = {};
  for (const w of subset) {
    bySid[w.sessionId] = bySid[w.sessionId] || [];
    bySid[w.sessionId].push(w);
  }
  const topSid = Object.entries(bySid).sort((a, b) => b[1].length - a[1].length)[0];
  if (!topSid) return;
  const [sid, list] = topSid;
  const layerKeys = Object.keys(list[0].layers || {});
  const stats = {};
  for (const k of layerKeys) {
    const vals = list.map(w => w.layers?.[k] ?? 0);
    const uniq = new Set(vals);
    stats[k] = {
      min: Math.min(...vals),
      max: Math.max(...vals),
      avg: Math.round(vals.reduce((a, b) => a + b, 0) / vals.length),
      uniqueValuesCount: uniq.size,
      sampleValues: [...uniq].slice(0, 6),
    };
  }
  console.log(`=== 3. LAYER STABILITY IN SESSION ${label} (${sid}, n=${list.length} wakes) ===`);
  console.log(JSON.stringify(stats, null, 2));
}

analyzeLayerStability(privWakes, 'private:1587592535');
analyzeLayerStability(grpWakes, 'group:588475979');

// 3. Inspect actual final message array structure in DSH .v4.jsonl.zstd for owner_5d06 and group_e70d
const sDir = '/home/ubuntu/.dsh/sessions/--srv-denia-data-state-agents--';
for (const [label, sid] of [
  ['owner_5d06', 'session-5d062d1c-b11c-4cec-869f-7db1148cf4e0'],
  ['group_e70d', 'session-e70da340-3859-4445-adcc-7cc0f78c35d9'],
]) {
  const rows = readZstdJsonl(`${sDir}/${sid}/session.v4.jsonl.zstd`);
  const getUText = (r) => Array.isArray(r?.data?.content)
    ? r.data.content.map(c => c.text || `[${c.type}]`).join('\n')
    : String(r?.data?.content || '');
  const lastWakeMsg = [...rows].reverse().find(r => r.type === 'user/message' && getUText(r).includes('\u3010\u5f53\u524d\u65f6\u95f4\u3011'));
  const firstSysMsg = rows.find(r => r.type === 'system/message');
  const uText = getUText(lastWakeMsg);
  // Extract all \u3010...\u3011 section headers in order from the actual user/message!
  const headers = [...uText.matchAll(/\u3010[^\u3011\n]{1,30}\u3011/g)].map(m => ({ header: m[0], index: m.index }));
  console.log(`=== 4. ACTUAL DSH MESSAGE STRUCTURE: ${label} ===`);
  console.log(JSON.stringify({
    firstSystemMsgLen: JSON.stringify(firstSysMsg?.data || '').length,
    lastWakeUserMsgTotalChars: uText.length,
    sectionHeadersInOrder: headers.map((h, i) => ({
      order: i + 1,
      header: h.header,
      offset: h.index,
      sectionChars: (headers[i + 1] ? headers[i + 1].index : uText.length) - h.index,
    })),
  }, null, 2));
}
