import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { createOwnerQuoteManager } from '../src/owner-quote.js';
import { writeDailyUsage, localDayKey as budgetLocalDayKey } from '../src/token-budget.js';

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

// 1. Source verification: no QQ stop broadcasts & A2 cap wired
const bridgeSrc = fs.readFileSync(new URL('../src/bridge.js', import.meta.url), 'utf8');
assert.ok(!bridgeSrc.includes('【SurfCore】本轮已停止，避免继续消耗'), 'A2 must remove group/friend 【SurfCore】本轮已停止 QQ broadcast');
assert.ok(!bridgeSrc.includes("sendToQQ(key, '⏹️ 已停止')"), 'A2 must remove aborted ⏹️ 已停止 QQ broadcast');
assert.ok(bridgeSrc.includes('overBudgetDirectCapCNY'), 'A2 must wire overBudgetDirectCapCNY');
assert.ok(bridgeSrc.includes('emergencyBudgetSessions'), 'A2 must track emergencyBudgetSessions');

const h = await bridgeHarness({
  config: {
    ownerQQ: 1587592535,
    allow: { private: ['1587592535', '999888'], groups: ['12345'] },
    socialV2: {
      staticContext: { enabled: false },
      sticker: { enabled: false },
      tokenGuard: {
        enabled: true,
        minWakeGapMs: 0,
        maxDailyCostCNY: 8,
        overBudgetDirectCapCNY: 4,
      },
    },
  },
  globals: {
    createOwnerQuoteManager,
    localDayKey: budgetLocalDayKey,
  },
});

try {
  h.setMode('reserved2');
  const surfcoreDir = path.join(h.temp, 'dsh', 'surfcore');
  const groupKey = 'group:12345';
  const friendKey = 'private:999888';
  const gSt = h.getSocialV2State(groupKey);
  const fSt = h.getSocialV2State(friendKey);
  gSt.bootstrapSent = true;
  fSt.bootstrapSent = true;

  // Seed QQ daily spend = ¥9.50 (> ¥8 daily limit, <= ¥12 emergency cap)
  writeDailyUsage(surfcoreDir, { qq: { cost: 9.5, tokens: 1_000_000 }, bili: { cost: 0, tokens: 0 }, other: { cost: 0, tokens: 0 } }, { at: Date.now() });

  await withServer(h, async (port) => {
    const daily = await call(port, '/api/tokens/daily', { headers: ADMIN });
    assert.equal(daily.json?.gate?.blocked, true, `Expected daily gate blocked at ¥9.50, got ${daily.body}`);

    const promptsBefore = h.calls.prompts.length;
    const sentBefore = h.calls.sent.length;

    // 2a. Proactive / autonomous / replyCheck / non-direct question wakes must ALL stay silently blocked
    for (const reason of ['proactiveCheck', 'autonomous', 'replyCheck', 'question']) {
      await h.sendWakePromptV2(groupKey, reason);
      assert.equal(h.calls.prompts.length, promptsBefore, `Over-budget ${reason} wake must NOT fire a model prompt (lastWakeBlock=${JSON.stringify(gSt.lastWakeBlock)})`);
      assert.equal(gSt.lastWakeBlock?.guardReason, 'budget', `Over-budget ${reason} must record budget block`);
      h.pendingWakeKeys?.delete?.(groupKey);
    }

    // 2b. Genuine strict-direct wakes (atMention, poke in group; private DM in friend private) MUST fire under +¥4 emergency cap
    for (const [k, reason, st] of [[groupKey, 'atMention', gSt], [groupKey, 'poke', gSt], [friendKey, 'private', fSt]]) {
      const prevCount = h.calls.prompts.length;
      await h.sendWakePromptV2(k, reason);
      assert.equal(h.calls.prompts.length, prevCount + 1, `Strict direct wake (${k} ${reason}) must bypass ¥8 base limit within ¥12 cap (lastWakeBlock=${JSON.stringify(st.lastWakeBlock)})`);
      assert.equal(st.overBudgetDirectTurn, true, `Wake must mark overBudgetDirectTurn for ${k}`);
      h.pendingWakeKeys?.delete?.(k);
    }

    // 2c. Owner private chat is excluded from QQ/total daily budget and always wakes even above ¥12
    writeDailyUsage(surfcoreDir, { qq: { cost: 12.5, tokens: 2_000_000 }, bili: { cost: 0, tokens: 0 }, other: { cost: 0, tokens: 0 } }, { at: Date.now() });
    const ownerKey = 'private:1587592535';
    const oSt = h.getSocialV2State(ownerKey);
    oSt.bootstrapSent = true;
    const prevOwnerCount = h.calls.prompts.length;
    await h.sendWakePromptV2(ownerKey, 'private');
    assert.equal(h.calls.prompts.length, prevOwnerCount + 1, 'Owner private must remain excluded from QQ daily budget');
    h.pendingWakeKeys?.delete?.(ownerKey);

    // 2d. Once total QQ spend >= ¥12 (exceeds base + emergency cap), even atMention & friend private must stay silently blocked
    for (const [k, reason, st] of [[groupKey, 'atMention', gSt], [friendKey, 'private', fSt]]) {
      const prevCount = h.calls.prompts.length;
      await h.sendWakePromptV2(k, reason);
      assert.equal(h.calls.prompts.length, prevCount, `Spend >= ¥12 must block even direct wake (${k} ${reason})`);
      assert.equal(st.lastWakeBlock?.guardReason, 'budget', `Exceeding ¥12 cap must record budget block for ${k}`);
      h.pendingWakeKeys?.delete?.(k);
    }

    assert.equal(h.calls.sent.length, sentBefore, 'Over-budget blocking must send 0 QQ broadcast messages');
  });

  console.log('✅ test-a2-silent-overbudget passed');
} finally {
  await h.close();
}
