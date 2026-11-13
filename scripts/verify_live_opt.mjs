import fs from 'node:fs';

// 1. Check latest wake entries in context-telemetry-bridge.jsonl
const lines = fs.readFileSync('/srv/denia/data/state/context-telemetry-bridge.jsonl', 'utf8')
  .trim()
  .split('\n')
  .filter(Boolean);

const wakes = [];
for (const l of lines.slice(-400)) {
  try {
    const r = JSON.parse(l);
    if (r.kind === 'wake') wakes.push(r);
  } catch {}
}
console.log('=== Latest wake telemetry ===');
for (const w of wakes.slice(-5)) {
  console.log(JSON.stringify({
    at: new Date(w.ts).toISOString(),
    key: w.key,
    reason: w.wakeReason || w.reason,
    promptChars: w.promptChars,
    sections: w.sections || w.wakeSections,
  }));
}

// 2. Check social-v2.json structure & owner staticContextState
const s2 = JSON.parse(fs.readFileSync('/srv/denia/data/state/social-v2.json', 'utf8'));
const ownerRec = s2.sessions?.['private:1587592535'] || s2.conversations?.['private:1587592535'] || s2['private:1587592535'];
console.log('=== social-v2.json top keys ===', Object.keys(s2).slice(0, 10));
if (ownerRec) {
  console.log('=== Owner staticContextState ===', JSON.stringify({
    sessionTurns: ownerRec.sessionTurns,
    staticContextState: {
      ...(ownerRec.staticContextState || {}),
      injectedMemoryCount: ownerRec.staticContextState?.injectedMemoryIds?.length ?? null,
      injectedMemoryIds: undefined,
    },
  }));
}

// 3. Query bridge /api/status or /api/dsh/presets with x-console-token
const token = fs.readFileSync('/srv/denia/data/state/console-token', 'utf8').trim();
for (const ep of ['/api/presets']) {
  const res = await fetch(`http://127.0.0.1:3100${ep}`, {
    headers: { 'x-console-token': token },
  });
  console.log(`=== ${ep} (${res.status}) ===`);
  console.log(await res.text());
}
