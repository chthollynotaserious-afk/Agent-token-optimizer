import assert from 'node:assert/strict';
import test from 'node:test';
import {
  evaluateSessionRotation,
  buildHandoffSummary,
  rotateSession,
  consumePendingHandoff,
} from '../src/session-rotation.js';

test('Opt-1 轮转判定：覆盖私聊/群聊轮次、120k Token 红线与 4h 闲置条件', () => {
  const now = 1_700_000_000_000;
  assert.deepEqual(
    evaluateSessionRotation('private:1001', { sessionTurns: 29, lastActionAt: now }, { currentSessionId: 's1', now }),
    { shouldRotate: false, reason: '' }
  );
  assert.deepEqual(
    evaluateSessionRotation('private:1001', { sessionTurns: 30, lastActionAt: now }, { currentSessionId: 's1', now }),
    { shouldRotate: true, reason: 'turns_limit_30' }
  );
  assert.deepEqual(
    evaluateSessionRotation('group:2002', { sessionTurns: 25, lastActionAt: now }, { currentSessionId: 's2', now }),
    { shouldRotate: true, reason: 'turns_limit_25' }
  );
  assert.deepEqual(
    evaluateSessionRotation('private:1001', { sessionTurns: 3, lastActionAt: now }, { currentSessionId: 's1', currentInputTokens: 120000, now }),
    { shouldRotate: true, reason: 'tokens_limit_120k' }
  );
});

test('弥补方案一 + 二 + 四：滑窗交接、Auto-Flush 钩子与按需调阅提示闭环', () => {
  const now = 1_700_000_000_000;
  const st = {
    sessionTurns: 25,
    lastActionAt: now,
    staticContextState: { sessionId: 's-old', staticHash: 'abc' },
    recentMessages: [
      { sender: 'User', text: '消息1' },
      { sender: 'Agent', text: '消息2' },
      { sender: 'User', text: '消息3' },
      { sender: 'Agent', text: '消息4' },
      { sender: 'User', text: '消息5' },
      { sender: 'Agent', text: '消息6' },
      { sender: 'User', text: '那后来呢？刚喝完咖啡准备去寄快递' },
    ],
  };
  const state = { sessions: { 'group:2002': 's-old' }, sessionHistory: {} };

  let flushed = null;
  const rotated = rotateSession('group:2002', st, state, {
    now,
    onBeforeRotate: (ctx) => {
      // 在轮转重置前执行记忆沉淀/再巩固
      flushed = { from: ctx.fromSessionId, count: ctx.recentMessages.length, reason: ctx.reason };
    },
  });

  assert.equal(rotated, true);
  assert.deepEqual(flushed, { from: 's-old', count: 7, reason: 'turns_limit_25' });
  assert.equal(state.sessions['group:2002'], undefined);
  assert.equal(state.sessionHistory['group:2002'][0].sessionId, 's-old');
  assert.equal(st.sessionTurns, 0);
  assert.equal(st.staticContextState, null);

  const handoff = consumePendingHandoff(st);
  // 弥补方案一：仅取末尾 6 条原文滑窗（不包含消息1），且不写入 valence/arousal 数值
  assert.ok(!handoff.includes('消息1'));
  assert.ok(handoff.includes('消息2'));
  assert.ok(handoff.includes('刚喝完咖啡准备去寄快递'));
  assert.ok(!/valence|arousal/i.test(handoff));
  // 弥补方案四：按需调阅提示
  assert.ok(handoff.includes('早前历史调阅提示'));
  // 二次消费应为空（仅首轮注入一次）
  assert.equal(consumePendingHandoff(st), '');
});

test('buildHandoffSummary 支持空消息列表仍保留按需调阅提示', () => {
  const summary = buildHandoffSummary([]);
  assert.ok(summary.includes('早前历史调阅提示'));
});
