import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { createOwnerQuoteManager } from '../src/owner-quote.js';

const ADMIN = { 'x-console-token': 'fixture-console-token' };

function call(port, pathname, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      { host: '127.0.0.1', port, path: pathname, method, headers: { 'content-type': 'application/json', ...headers } },
      (response) => {
        let data = '';
        response.on('data', (chunk) => { data += chunk; });
        response.on('end', () => {
          let json = null;
          try { json = JSON.parse(data); } catch {}
          resolve({ status: response.statusCode, body: data, json });
        });
      },
    );
    request.on('error', reject);
    request.setTimeout(5000, () => request.destroy(new Error('request hung')));
    request.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

async function withServer(h, run) {
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  try { await run(server.address().port); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}

const h = await bridgeHarness({
  config: {
    ownerQQ: 1587592535,
    allow: { private: ['1587592535'], groups: [] },
    socialV2: {
      staticContext: {
        enabled: true,
        allowKeys: ['*'],
        privateRefreshEveryTurns: 25,
        groupRefreshEveryTurns: 12,
      },
      memoryBook: { enabled: true, injectCore: true },
      sticker: { enabled: false },
      tokenGuard: { enabled: true, minWakeIntervalMs: 0, maxDailyCostCNY: 999 },
    },
  },
  globals: {
    createOwnerQuoteManager,
  },
});

try {
  h.setMode('reserved2');
  const key = 'private:1587592535';
  const st = h.getSocialV2State(key);
  st.memberImpressions = {
    '测试群友': { traits: ['爱敲代码', '说话简洁'], interactionCount: 3 },
  };
  st.activeTopics = [{ text: '讨论 Opt-3 去重', lastMentionAt: Date.now() }];

  // Seed a core memory card & memory book file inside harness temp dir
  const memDir = path.join(h.temp, 'dsh', 'surfcore', 'memory');
  fs.mkdirSync(memDir, { recursive: true });
  fs.writeFileSync(path.join(memDir, 'memory-card.json'), JSON.stringify({
    version: 1,
    records: [{
      id: 'mem_opt3_test_1',
      title: '测试记忆',
      text: '主人喜欢低消耗且稳定的守护进程。',
      kind: 'fact',
      pinned: true,
      isOwner: true,
      speaker: '主人',
      scope: 'qq',
      source: 'qq-owner',
      importance: 90,
      confidence: 0.95,
      audience: 'owner',
      platform: 'qq',
      conversationKey: key,
      createdAt: new Date(Date.now() - 86400000).toISOString(),
    }],
  }, null, 2));

  await withServer(h, async (port) => {
    // Turn 1: bootstrap (full injection)
    const r1 = await call(port, '/api/socialV2/wake', {
      method: 'POST', headers: ADMIN, body: { key, reason: 'admin' },
    });
    assert.equal(r1.status, 200);
    for (let i = 0; i < 60 && h.calls.prompts.length < 1; i += 1) await new Promise((r) => setTimeout(r, 25));
    assert.equal(h.calls.prompts.length, 1);
    const p1 = h.calls.prompts[0].content.map((c) => String(c?.text ?? '')).join('\n');
    assert.ok(p1.includes('【Token 防爆破】'), 'Turn 1 must contain tokenGuardLine');
    assert.ok(p1.includes('【主人提议休息时的自主决定】'), 'Turn 1 must contain ownerSleepAutonomyLine');
    assert.ok(p1.includes('【对群友的印象】'), 'Turn 1 must contain memberImpressions');
    assert.ok(p1.includes('测试记忆') || p1.includes('低消耗且稳定的守护进程'), 'Turn 1 must contain seeded memory card');
    assert.ok(!p1.includes('【会话静态锚点】'), 'Turn 1 must not use static anchor');
    assert.ok(st.staticContextState?.staticHash, 'Turn 1 must commit staticHash');
    assert.ok(Array.isArray(st.staticContextState?.injectedMemoryIds) && st.staticContextState.injectedMemoryIds.includes('mem_opt3_test_1'), 'Turn 1 must record injectedMemoryIds');
    const hash1 = st.staticContextState.staticHash;
    h.pendingWakeKeys?.delete?.(key);

    // Turn 2: no state change -> full Opt-3 dedup
    const r2 = await call(port, '/api/socialV2/wake', {
      method: 'POST', headers: ADMIN, body: { key, reason: 'admin' },
    });
    assert.equal(r2.status, 200);
    for (let i = 0; i < 60 && h.calls.prompts.length < 2; i += 1) await new Promise((r) => setTimeout(r, 25));
    assert.equal(h.calls.prompts.length, 2, `Turn 2 did not fire prompt: ${r2.body}`);
    const p2 = h.calls.prompts[1].content.map((c) => String(c?.text ?? '')).join('\n');
    assert.ok(p2.includes('【会话静态锚点】'), 'Turn 2 must inject static anchor');
    assert.ok(!p2.includes('【Token 防爆破】'), 'Turn 2 must omit tokenGuardLine');
    assert.ok(!p2.includes('【主人提议休息时的自主决定】'), 'Turn 2 must omit ownerSleepAutonomyLine');
    assert.ok(!p2.includes('【对群友的印象】'), 'Turn 2 must omit unchanged memberImpressions');
    assert.ok(!p2.includes('低消耗且稳定的守护进程'), 'Turn 2 must omit already-injected memory card');
    assert.ok(p2.includes('讨论 Opt-3 去重'), 'Turn 2 must keep live activeTopics');
    assert.ok(p2.length < p1.length - 1000, `Turn 2 (${p2.length}) should be substantially shorter than Turn 1 (${p1.length})`);
    assert.equal(st.staticContextState.turnsSinceFullInject, 1);
    h.pendingWakeKeys?.delete?.(key);

    // Turn 3: mutate memberImpressions -> ONLY memberImpressions re-emits, staticHash stays unbroken!
    st.memberImpressions['测试群友'].interactionCount = 4;
    const r3 = await call(port, '/api/socialV2/wake', {
      method: 'POST', headers: ADMIN, body: { key, reason: 'admin' },
    });
    assert.equal(r3.status, 200);
    for (let i = 0; i < 60 && h.calls.prompts.length < 3; i += 1) await new Promise((r) => setTimeout(r, 25));
    assert.equal(h.calls.prompts.length, 3, `Turn 3 did not fire prompt: ${r3.body}`);
    const p3 = h.calls.prompts[2].content.map((c) => String(c?.text ?? '')).join('\n');
    assert.ok(p3.includes('【会话静态锚点】'), 'Turn 3 must keep staticHash unbroken');
    assert.ok(p3.includes('【对群友的印象】') && p3.includes('互动 4 次'), 'Turn 3 must emit updated memberImpressions');
    assert.ok(!p3.includes('【Token 防爆破】'), 'Turn 3 must not bust tokenGuardLine');
    assert.ok(!p3.includes('低消耗且稳定的守护进程'), 'Turn 3 must keep memoryCard omitted');
    assert.equal(st.staticContextState.staticHash, hash1);
    assert.equal(st.staticContextState.turnsSinceFullInject, 2);

    console.log(`✅ Opt-3 expansion integration test passed! Turn1=${p1.length} chars -> Turn2=${p2.length} chars (-${p1.length - p2.length}) -> Turn3(delta)=${p3.length} chars`);
  });
} finally {
  await h.close();
}
