import assert from 'node:assert/strict';
import test from 'node:test';
import { SessionLifecycleController, evaluateRotationNeed } from '../../src/core/session-lifecycle.js';
import { AuditLog } from '../../src/observability/audit-log.js';

test('evaluateRotationNeed triggers on turns, tokens, or idle timeout', () => {
  const now = 1_700_000_000_000;
  assert.equal(
    evaluateRotationNeed('agent:1', { sessionTurns: 30, lastActionAt: now }, { currentSessionId: 's1', now }).shouldRotate,
    true
  );
  assert.equal(
    evaluateRotationNeed('agent:1', { sessionTurns: 2, lastActionAt: now }, { currentSessionId: 's1', currentInputTokens: 125_000, now }).shouldRotate,
    true
  );
});

test('7-step transactional rotation awaits async flush, verifies recovery, and preserves handoff', async () => {
  const audit = new AuditLog();
  const ctrl = new SessionLifecycleController({ auditLog: audit });
  const st = {
    sessionTurns: 30,
    lastActionAt: 1000,
    staticContextState: { hash: 'old' },
    recentMessages: [
      { role: 'user', content: 'Fix bug in auth.ts' },
      { role: 'assistant', content: 'Updated token check in auth.ts' },
    ],
  };
  const globalState = { sessions: { 'task:auth': 's-old' }, sessionHistory: {} };

  let persisted = false;
  const res = await ctrl.rotateIfNeeded('task:auth', st, globalState, {
    now: 2000,
    onBeforeRotate: async () => {
      await new Promise((r) => setTimeout(r, 15));
      persisted = true;
      return { flushed: true, verificationToken: 'v-123' };
    },
    verifyPersistence: async ({ flushResult }) => persisted && flushResult.verificationToken === 'v-123',
    verifyRecovery: async ({ handoff }) => handoff.summary.includes('auth.ts'),
  });

  assert.equal(res.rotated, true);
  assert.equal(res.rolledBack, false);
  assert.notEqual(res.sessionId, 's-old');
  assert.equal(globalState.sessions['task:auth'], res.sessionId);
  assert.equal(st.sessionTurns, 0);
  assert.equal(st.staticContextState, null);
  assert.equal(globalState.sessionHistory['task:auth'][0].sessionId, 's-old');

  const handoffText = ctrl.consumePendingHandoff(st);
  assert.ok(handoffText.includes('auth.ts'));
  assert.ok(!/valence|arousal/i.test(handoffText));
  assert.equal(ctrl.consumePendingHandoff(st), '');
});

test('7-step rotation rolls back completely when async flush or recovery fails', async () => {
  const audit = new AuditLog();
  const ctrl = new SessionLifecycleController({ auditLog: audit });

  // Case 1: async flush throws
  const st1 = { sessionTurns: 30, lastActionAt: 1000, staticContextState: { hash: 'keep' }, recentMessages: [] };
  const gs1 = { sessions: { 'k1': 's-keep' }, sessionHistory: {} };
  const r1 = await ctrl.rotateIfNeeded('k1', st1, gs1, {
    onBeforeRotate: async () => { throw new Error('disk_full'); },
  });
  assert.equal(r1.rotated, false);
  assert.equal(r1.rolledBack, true);
  assert.equal(gs1.sessions.k1, 's-keep');
  assert.equal(st1.sessionTurns, 30);
  assert.deepEqual(st1.staticContextState, { hash: 'keep' });
  assert.equal((gs1.sessionHistory.k1 ?? []).length, 0);
  assert.equal(ctrl.isLocked('k1'), false);

  // Case 2: recovery verification fails -> still rolls back
  const st2 = { sessionTurns: 30, lastActionAt: 1000, staticContextState: { hash: 'keep2' }, recentMessages: [] };
  const gs2 = { sessions: { 'k2': 's-keep-2' }, sessionHistory: {} };
  const r2 = await ctrl.rotateIfNeeded('k2', st2, gs2, {
    onBeforeRotate: async () => ({ flushed: true }),
    verifyRecovery: async () => false,
  });
  assert.equal(r2.rotated, false);
  assert.equal(r2.rolledBack, true);
  assert.equal(gs2.sessions.k2, 's-keep-2');
  assert.equal(st2.sessionTurns, 30);
  assert.equal(st2.pendingHandoff, null);
});
