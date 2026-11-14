import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

// Verify EVERY legacy root src/*.js module imports cleanly and retains backward-compatible behavior
import { createTokenLedger, usageOfEvent } from '../../src/token-ledger.js';
import { buildToolAttribution } from '../../src/tool-cost-attribution.js';
import { evaluateStaticDedup, commitStaticDedupState } from '../../src/static-context-dedup.js';
import { fingerprintPrompt, firstDifference } from '../../src/prompt-fingerprint.js';
import { evaluateProactiveGate, computeProactiveDelayMs } from '../../src/proactive-gate.js';
import { proactiveProbability, proactiveDecision } from '../../src/proactive-policy.js';
import { proactiveConfigFor, inActiveHours } from '../../src/proactive-config.js';
import { createTurnGuard, isExpectedToolError } from '../../src/turn-guard.js';
import { assessTurnEnd, turnEndHint } from '../../src/turn-end-policy.js';
import { evaluateBudget, collectAlerts, normalizeLimits } from '../../src/token-budget.js';
import { evaluateWakeBudget, evaluateOutbound } from '../../src/token-guard.js';
import { createPriorityBudget, PRIORITIES } from '../../src/priority-budget.js';
import { selectWaitBatch, looksLikeUnfinished } from '../../src/v2-wait.js';
import { LEGACY_CNY_PRICE_TABLE } from '../../src/model-prices.js';

test('legacy token-ledger and tool-cost-attribution import and compute accurately without host files', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uao-legacy-ledger-'));
  try {
    const ledger = createTokenLedger({
      file: path.join(tmpDir, 'token-usage.jsonl'),
      priceTable: LEGACY_CNY_PRICE_TABLE,
      resolveKey: () => 'private:1001',
    });
    const ts = new Date(2026, 10, 14, 10, 0, 0).getTime();
    const ok = ledger.ingestEvent({
      sessionId: 'sid-1',
      model: 'deepseek-flash',
      at: ts,
      event: {
        seq: 1,
        type: 'assistant/message',
        data: {
          turn: 1,
          step: 1,
          usage: { cacheMiss: 1000, cacheHit: 9000, output: 200 },
        },
      },
    });
    assert.equal(ok, true);
    const sum = ledger.summary();
    assert.equal(sum.ok, true);
    assert.equal(sum.totals.inputTokens, 10000);
    assert.ok(sum.totals.cost > 0);
    assert.equal(usageOfEvent({ type: 'assistant/message', data: { usage: { cacheMiss: 1 } } }).cacheMiss, 1);

    const attr = buildToolAttribution(
      {
        modelCalls: [
          { sessionId: 'sid-1', turn: 1, step: 1, ts: 1000, model: 'deepseek-flash', usage: { cacheMiss: 1000, cacheHit: 2000 } },
          { sessionId: 'sid-1', turn: 1, step: 2, ts: 2000, model: 'deepseek-flash', usage: { cacheMiss: 1500, cacheHit: 3500 } },
        ],
        toolResults: [
          { sessionId: 'sid-1', turn: 1, ts: 1500, callId: 'c1', tool: 'fs_read', resultChars: 4200, ok: true },
        ],
      },
      { table: LEGACY_CNY_PRICE_TABLE }
    );
    assert.equal(attr.estimated, true);
    assert.equal(attr.linkedCalls, 1);
    assert.equal(attr.tools[0].tool, 'fs_read');
    assert.equal(attr.tools[0].attributedInput, 2000);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Opt-3 static-context-dedup & prompt-fingerprint omit unchanged static block and normalize IDs', () => {
  const staticBlock = 'STATIC RULES '.repeat(50);
  const d1 = evaluateStaticDedup({
    key: 'private:1001',
    sessionId: 's1',
    staticBlock,
    prevStatic: null,
    stickerRaw: 'stickers-v1',
    memoryCard: { fullText: 'mem1', usedIds: ['m1'], lineById: new Map([['m1', '- mem1']]) },
  });
  assert.equal(d1.canOmitStatic, false);
  const state1 = commitStaticDedupState(null, d1.pendingCommit, 1000);

  const d2 = evaluateStaticDedup({
    key: 'private:1001',
    sessionId: 's1',
    staticBlock,
    prevStatic: state1,
    stickerRaw: 'stickers-v1',
    memoryCard: { fullText: 'mem1\nmem2', usedIds: ['m1', 'm2'], lineById: new Map([['m1', '- mem1'], ['m2', '- mem2']]) },
  });
  assert.equal(d2.canOmitStatic, true);
  assert.equal(d2.stickerLine, '');
  assert.ok(d2.memoryCardLine.includes('mem2'));
  assert.ok(!d2.memoryCardLine.includes('mem1'));

  const fp1 = fingerprintPrompt('Time 2026-11-14T10:00:00Z private:123456 hello');
  const fp2 = fingerprintPrompt('Time 2026-11-14T11:30:00Z private:999999 hello');
  assert.notEqual(fp1.hash, fp2.hash);
  assert.equal(fp1.hashNorm, fp2.hashNorm);
  assert.equal(firstDifference('a 2026/11/14', 'a 2026/11/15').same, true);
  assert.equal(firstDifference('a 2026/11/14 foo', 'a 2026/11/15 bar').same, false);
});

test('Opt-4 proactive gate, policy, and config preserve urgent pass and backoff', () => {
  const now = Date.UTC(2026, 10, 14, 12, 0, 0);
  const urgent = evaluateProactiveGate({
    st: { unread: ['hi'], lastProactiveSentAt: now - 1000, lastIncomingAt: now - 5000 },
    now,
  });
  assert.equal(urgent.allow, true);
  assert.equal(urgent.reason, 'unread');

  const locked = evaluateProactiveGate({
    st: { unread: [], lastProactiveSentAt: now - 1000, lastIncomingAt: now - 5000 },
    now,
  });
  assert.equal(locked.allow, false);
  assert.equal(locked.reason, 'no-reply-lock');

  assert.ok(computeProactiveDelayMs({ silentStreak: 2, minMs: 60_000, maxMs: 60_000 }) > 60_000);
  const p = proactiveProbability({ probBase: 0.4, hour: 12 });
  assert.equal(p.bias, 0);
  assert.equal(proactiveDecision({ draw: 0.1, prob: 0.5, idleMs: 1000, idleThresholdMs: 500, sinceProactiveMs: 1000, cooldownMs: 500 }), true);

  const eff = proactiveConfigFor({ socialV2: { proactive: { groups: { '12345': { probability: 0.8 } } } } }, 'group:12345');
  assert.equal(eff.probability, 0.8);
  assert.equal(inActiveHours({ start: '08:00', end: '22:00' }, new Date(2026, 10, 14, 12, 0, 0)), true);
});

test('Opt-5 turn-guard, turn-end-policy, and v2-wait enforce loop guards cleanly', () => {
  const guard = createTurnGuard({ maxSteps: 2, maxRepeatedErrors: 2 });
  guard.begin('s1', 'private:1');
  assert.equal(guard.noteStep('s1', { callId: '1', tool: 'fs_read', args: { p: 'a' } }), null);
  assert.equal(guard.noteToolError('s1', 'fs_read', 'ENOENT'), null);
  assert.equal(guard.noteToolError('s1', 'fs_read', 'ENOENT')?.code, 'TURN_REPEATED_TOOL_ERROR');
  assert.equal(isExpectedToolError('permission denied'), true);

  const endDecision = assessTurnEnd({
    hasSuccessfulSend: true,
    unseenUnread: 0,
    pendingThoughts: 0,
    quietMs: 10_000,
    config: { enabled: true, mode: 'enforce', quietMs: 8_000 },
  });
  assert.equal(endDecision.eligible, true);
  assert.ok(turnEndHint(endDecision).length > 0);

  assert.equal(looksLikeUnfinished('等一下'), true);
  const batch = selectWaitBatch([{ text: 'a' }, { text: 'important' }, { text: 'b' }], {
    maxMessages: 2,
    isImportant: (m) => m.text === 'important',
  });
  assert.equal(batch.selected.length, 2);
});

test('Token budget, token guard, and priority budget enforce quotas cleanly', () => {
  const limits = normalizeLimits({ qq: { cny: 10, tokens: 1000 } });
  const usage = { qq: { cost: 8.5, tokens: 500 }, bili: { cost: 0, tokens: 0 }, other: { cost: 0, tokens: 0 } };
  assert.equal(collectAlerts(usage, limits).length, 1);
  assert.equal(evaluateBudget(usage, limits).blocked, false);
  assert.equal(evaluateBudget({ qq: { cost: 10.5, tokens: 500 } }, limits).blocked, true);

  const wakeBlocked = evaluateWakeBudget({ key: 'group:1', wakeTimes: [1, 2], now: 100, guard: { maxWakesPerDay: 2 } });
  assert.equal(wakeBlocked.blocked, true);
  const wakeDirect = evaluateWakeBudget({ key: 'group:1', wakeTimes: [1, 2], now: 100, guard: { maxWakesPerDay: 2 }, direct: true });
  assert.equal(wakeDirect.blocked, false);
  assert.equal(evaluateOutbound({ used: 12, count: 1 }).blocked, true);

  const pb = createPriorityBudget();
  assert.equal(pb.check({ task: 'help' }).priority, PRIORITIES.P0);
  assert.equal(pb.check({ task: 'chat' }).priority, PRIORITIES.P2);
});
