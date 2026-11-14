/**
 * Session Lifecycle Engine (Opt-1 evolved)
 *
 * Implements a 7-step transactional session rotation workflow to eliminate
 * async memory-flush race conditions, lost handoffs, and inconsistent state:
 *   1. Acquire session mutation lock
 *   2. Execute async pre-rotation memory flush (onBeforeRotate / StateProvider)
 *   3. Verify persistence succeeded
 *   4. Persist handoff envelope (raw tail window + recall pointer, no numeric mood tags)
 *   5. Create/activate clean next session & reset turn/dedup counters
 *   6. Verify context recovery readiness
 *   7. Rollback cleanly on any failure, preserving the previous session intact
 */

import crypto from 'node:crypto';

export const DEFAULT_LIFECYCLE_LIMITS = Object.freeze({
  defaultMaxTurns: 30,
  groupMaxTurns: 25,
  maxIdleMs: 4 * 3600 * 1000,
  maxContextTokens: 120_000,
  idleTokenThreshold: 70_000,
  tailWindowSize: 6,
  tailLineMaxChars: 150,
  maxHistoryEntries: 20,
});

export function evaluateRotationNeed(conversationKey, sessionState, opts = {}) {
  if (!sessionState || !opts.currentSessionId) {
    return { shouldRotate: false, reason: '' };
  }
  const limits = { ...DEFAULT_LIFECYCLE_LIMITS, ...(opts.limits || {}) };
  const scopeType = opts.scopeType || (String(conversationKey).startsWith('group:') ? 'group' : 'default');
  const maxTurns = scopeType === 'group' ? limits.groupMaxTurns : limits.defaultMaxTurns;
  const turns = Number(sessionState.sessionTurns) || 0;
  const lastActive = Number(sessionState.lastActionAt || sessionState.lastAiReplyAt) || 0;
  const curTokens = Number(opts.currentInputTokens) || 0;
  const now = Number(opts.now) || Date.now();

  if (curTokens >= limits.maxContextTokens) {
    return { shouldRotate: true, reason: `tokens_limit_${Math.round(curTokens / 1000)}k` };
  }
  if (turns >= maxTurns) {
    return { shouldRotate: true, reason: `turns_limit_${turns}` };
  }
  if (
    lastActive > 0
    && now - lastActive > limits.maxIdleMs
    && (turns >= 1 || curTokens >= limits.idleTokenThreshold)
  ) {
    return { shouldRotate: true, reason: `idle_timeout_${Math.round((now - lastActive) / 3600_000)}h` };
  }
  return { shouldRotate: false, reason: '' };
}

export function buildUniversalHandoff(recentMessages = [], opts = {}) {
  const windowSize = opts.tailWindowSize ?? DEFAULT_LIFECYCLE_LIMITS.tailWindowSize;
  const maxChars = opts.tailLineMaxChars ?? DEFAULT_LIFECYCLE_LIMITS.tailLineMaxChars;
  const agentName = opts.agentName || 'Assistant';
  const userName = opts.userName || 'User';

  const rawRecent = (Array.isArray(recentMessages) ? recentMessages : []).slice(-windowSize);
  const lines = rawRecent
    .map((m) => {
      const sender = m.sender || (m.role === 'assistant' ? agentName : userName);
      const raw = typeof m.content === 'string' ? m.content : (m.rawMessage || m.text || '');
      const text = String(raw).slice(0, maxChars).trim();
      return text ? `[${sender}]: ${text}` : null;
    })
    .filter(Boolean);

  const parts = [];
  if (lines.length > 0) {
    parts.push(`[Session Handoff Tail Window]\n${lines.join('\n')}`);
  }
  if (opts.includeRecallHint !== false) {
    parts.push(
      opts.recallHint
      || '[Recall Hint] Earlier conversation history is archived by sessionId; use recall/retrieval tools if prior details are referenced.'
    );
  }
  if (opts.protocolReminder) {
    parts.push(String(opts.protocolReminder));
  }
  return parts.join('\n');
}

export class SessionLifecycleController {
  constructor({
    limits = {},
    stateProvider = null,
    auditLog = null,
    generateSessionId = () => `sess_${crypto.randomUUID()}`,
  } = {}) {
    this.limits = { ...DEFAULT_LIFECYCLE_LIMITS, ...limits };
    this.stateProvider = stateProvider;
    this.auditLog = auditLog;
    this.generateSessionId = generateSessionId;
    this.locks = new Set();
  }

  isLocked(conversationKey) {
    return this.locks.has(conversationKey);
  }

  /**
   * 7-Step Transactional Rotation
   */
  async rotateIfNeeded(conversationKey, sessionState, globalState, opts = {}) {
    const currentSessionId = globalState?.sessions?.[conversationKey];
    const check = evaluateRotationNeed(conversationKey, sessionState, {
      ...opts,
      limits: { ...this.limits, ...(opts.limits || {}) },
      currentSessionId,
    });
    if (!check.shouldRotate) {
      return { rotated: false, rolledBack: false, reason: '', sessionId: currentSessionId || null };
    }

    // Step 1: Acquire mutation lock
    if (this.locks.has(conversationKey)) {
      return { rotated: false, rolledBack: false, reason: 'rotation_already_in_progress', sessionId: currentSessionId };
    }
    this.locks.add(conversationKey);

    const now = Number(opts.now) || Date.now();
    // Snapshot mutable state for atomic rollback
    const snapshot = {
      sessionId: currentSessionId,
      sessionTurns: sessionState.sessionTurns,
      staticContextState: sessionState.staticContextState ? structuredClone(sessionState.staticContextState) : null,
      pendingHandoff: sessionState.pendingHandoff ? structuredClone(sessionState.pendingHandoff) : null,
      historyLen: Array.isArray(globalState.sessionHistory?.[conversationKey])
        ? globalState.sessionHistory[conversationKey].length
        : 0,
    };

    try {
      // Step 2: Complete async memory flush
      const recentMessages = Array.isArray(sessionState.recentMessages) ? sessionState.recentMessages : [];
      let flushResult = { flushed: true };
      if (typeof opts.onBeforeRotate === 'function') {
        const res = await opts.onBeforeRotate({
          key: conversationKey,
          st: sessionState,
          fromSessionId: currentSessionId,
          reason: check.reason,
          now,
          recentMessages,
        });
        if (res && typeof res === 'object') flushResult = res;
      } else if (this.stateProvider?.onBeforeSessionRotate) {
        flushResult = await this.stateProvider.onBeforeSessionRotate({
          conversationKey,
          fromSessionId: currentSessionId,
          recentMessages,
        });
      }

      // Step 3: Verify persistence succeeded
      if (flushResult?.flushed === false) {
        throw new Error(flushResult.error || 'pre_rotation_flush_failed');
      }
      if (typeof opts.verifyPersistence === 'function') {
        const verified = await opts.verifyPersistence({
          conversationKey,
          fromSessionId: currentSessionId,
          flushResult,
        });
        if (!verified) throw new Error('persistence_verification_failed');
      }

      // Step 4: Save handoff envelope
      const handoffSummary = buildUniversalHandoff(recentMessages, {
        ...this.limits,
        ...opts,
      });
      const handoff = {
        summary: handoffSummary,
        fromSessionId: currentSessionId,
        rotatedAt: now,
        reason: check.reason,
        verificationToken: flushResult?.verificationToken || null,
      };
      sessionState.pendingHandoff = handoff;

      // Step 5: Archive pointer & activate new session
      if (!globalState.sessions) globalState.sessions = {};
      if (!globalState.sessionHistory) globalState.sessionHistory = {};
      if (!globalState.sessionHistory[conversationKey]) globalState.sessionHistory[conversationKey] = [];
      globalState.sessionHistory[conversationKey].push({
        sessionId: currentSessionId,
        rotatedAt: now,
        turns: Number(sessionState.sessionTurns) || 0,
        reason: check.reason,
      });
      const maxHistory = this.limits.maxHistoryEntries;
      if (globalState.sessionHistory[conversationKey].length > maxHistory) {
        globalState.sessionHistory[conversationKey].shift();
      }

      const nextSessionId = opts.autoCreateSession === false ? null : this.generateSessionId();
      if (nextSessionId) {
        globalState.sessions[conversationKey] = nextSessionId;
      } else {
        delete globalState.sessions[conversationKey];
      }
      sessionState.sessionTurns = 0;
      sessionState.staticContextState = null;

      // Step 6: Verify context recovery readiness
      if (typeof opts.verifyRecovery === 'function') {
        const recovered = await opts.verifyRecovery({
          conversationKey,
          fromSessionId: currentSessionId,
          nextSessionId,
          handoff,
        });
        if (!recovered) throw new Error('context_recovery_verification_failed');
      }

      this.auditLog?.log('lifecycle', 'rotate_commit', {
        conversationKey,
        fromSessionId: currentSessionId,
        nextSessionId,
        reason: check.reason,
      });

      return {
        rotated: true,
        rolledBack: false,
        reason: check.reason,
        fromSessionId: currentSessionId,
        sessionId: nextSessionId,
        handoff,
      };
    } catch (err) {
      // Step 7: Rollback completely to previous session on any failure
      if (!globalState.sessions) globalState.sessions = {};
      globalState.sessions[conversationKey] = snapshot.sessionId;
      sessionState.sessionTurns = snapshot.sessionTurns;
      sessionState.staticContextState = snapshot.staticContextState;
      sessionState.pendingHandoff = snapshot.pendingHandoff;
      if (Array.isArray(globalState.sessionHistory?.[conversationKey])) {
        globalState.sessionHistory[conversationKey].length = snapshot.historyLen;
      }

      this.auditLog?.log('lifecycle', 'rotate_rollback', {
        conversationKey,
        sessionId: snapshot.sessionId,
        error: err?.message || String(err),
      });

      return {
        rotated: false,
        rolledBack: true,
        reason: check.reason,
        error: err?.message || String(err),
        sessionId: snapshot.sessionId,
      };
    } finally {
      this.locks.delete(conversationKey);
    }
  }

  consumePendingHandoff(sessionState) {
    if (!sessionState?.pendingHandoff?.summary) return '';
    const out = `${sessionState.pendingHandoff.summary}\n\n`;
    sessionState.pendingHandoff = null;
    return out;
  }
}
