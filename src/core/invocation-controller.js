/**
 * Autonomous Invocation Controller (Opt-4 evolved)
 *
 * Reduces zero-value LLM wakeups without dropping high-priority or user-direct events:
 *   - Priority channels: 'urgent' | 'user_direct' | 'normal' | 'low_proactive'
 *   - Wakeup deduplication / coalescing within a time window
 *   - Local rule evaluation + silent-streak exponential backoff
 *   - Budget-aware gating with explicit emergency bypass for urgent events
 */

export const PRIORITY_LEVELS = Object.freeze({
  URGENT: 'urgent',
  USER_DIRECT: 'user_direct',
  NORMAL: 'normal',
  LOW_PROACTIVE: 'low_proactive',
});

const HIGH_PRIORITY = new Set([PRIORITY_LEVELS.URGENT, PRIORITY_LEVELS.USER_DIRECT]);

export const DEFAULT_INVOCATION_CONFIG = Object.freeze({
  dedupeWindowMs: 5_000,
  cooldownMs: 15 * 60_000,
  idleThresholdMs: 15 * 60_000,
  baseBackoffMs: 30 * 60_000,
  maxBackoffMs: 8 * 3600_000,
  maxSilentExponent: 6,
  urgentMinGapMs: 0,
  respectQuietHoursForLow: true,
});

export class InvocationController {
  constructor({ config = {}, stateProvider = null, auditLog = null, now = () => Date.now() } = {}) {
    this.config = { ...DEFAULT_INVOCATION_CONFIG, ...config };
    this.stateProvider = stateProvider;
    this.auditLog = auditLog;
    this.now = now;
    this.recentEventKeys = new Map();
    this.sessionStats = new Map();
  }

  _getSession(key) {
    let s = this.sessionStats.get(key);
    if (!s) {
      s = {
        lastWakeAt: 0,
        lastUserAt: 0,
        lastProactiveSentAt: 0,
        silentStreak: 0,
      };
      this.sessionStats.set(key, s);
    }
    return s;
  }

  computeNextDelayMs(conversationKey, rand = 0.5) {
    const s = this._getSession(conversationKey);
    const base = this.config.baseBackoffMs;
    const max = this.config.maxBackoffMs;
    if (s.silentStreak <= 0) return Math.min(max, base);
    const exp = Math.min(s.silentStreak, this.config.maxSilentExponent);
    const jitter = 0.8 + 0.4 * Math.min(1, Math.max(0, Number(rand) || 0.5));
    return Math.min(max, Math.round(base * Math.pow(2, exp) * jitter));
  }

  /**
   * Evaluate whether a wakeup event should invoke the LLM.
   */
  async evaluateWake(event = {}) {
    const ts = Number.isFinite(Number(event.now)) ? Number(event.now) : this.now();
    const key = String(event.conversationKey || event.sessionId || 'default');
    const priority = String(event.priority || PRIORITY_LEVELS.NORMAL);
    const isUrgent = HIGH_PRIORITY.has(priority) || event.urgent === true || event.userMessage === true;
    const dedupeKey = event.dedupeKey ? `${key}:${event.dedupeKey}` : null;

    // 1. Event deduplication (coalesce duplicate identical triggers within dedupeWindowMs)
    if (dedupeKey && this.config.dedupeWindowMs > 0) {
      const prevTs = this.recentEventKeys.get(dedupeKey) || 0;
      if (ts - prevTs < this.config.dedupeWindowMs) {
        return this._decide(false, 'deduplicated', priority, key, { dedupeKey, windowMs: this.config.dedupeWindowMs });
      }
      this.recentEventKeys.set(dedupeKey, ts);
    }

    const sess = this._getSession(key);

    // 2. High-priority bypass channel: NEVER blocked by quiet hours, idle wait, or silent backoff
    if (isUrgent) {
      if (this.config.urgentMinGapMs > 0 && sess.lastWakeAt > 0 && ts - sess.lastWakeAt < this.config.urgentMinGapMs) {
        return this._decide(false, 'urgent_min_gap', priority, key);
      }
      if (event.userMessage === true) {
        sess.lastUserAt = ts;
        sess.silentStreak = 0;
      }
      sess.lastWakeAt = ts;
      return this._decide(true, 'urgent_bypass_channel', priority, key, { bypassedGates: true });
    }

    // 3. Budget-aware check (applies to non-urgent wakes)
    if (event.budgetRemaining === 0 || event.budgetBlocked === true) {
      return this._decide(false, 'budget_exhausted', priority, key);
    }

    // 4. Active / quiet hours check for low-priority wakes
    if (this.config.respectQuietHoursForLow && event.activeHoursOk === false) {
      return this._decide(false, 'outside_active_hours', priority, key);
    }

    if (event.busy === true) {
      return this._decide(false, 'session_busy', priority, key);
    }

    // 5. Concrete reason vs pure idle patrol
    const hasConcreteTrigger = Array.isArray(event.concreteReasons) && event.concreteReasons.length > 0;
    const sinceLastWake = sess.lastWakeAt > 0 ? ts - sess.lastWakeAt : Infinity;

    if (sinceLastWake < this.config.cooldownMs) {
      return this._decide(false, 'cooldown', priority, key, { sinceLastWake, cooldownMs: this.config.cooldownMs });
    }

    if (!hasConcreteTrigger && priority === PRIORITY_LEVELS.LOW_PROACTIVE) {
      if (sess.silentStreak > 0) {
        const backoff = this.computeNextDelayMs(key);
        if (sinceLastWake < backoff) {
          return this._decide(false, 'silent_streak_backoff', priority, key, {
            silentStreak: sess.silentStreak,
            backoffMs: backoff,
          });
        }
      }
      const idleMs = sess.lastUserAt > 0 ? ts - sess.lastUserAt : Infinity;
      if (idleMs < this.config.idleThresholdMs) {
        return this._decide(false, 'not_idle', priority, key, { idleMs });
      }
      if (typeof event.localScore === 'number') {
        const signals = this.stateProvider ? await this.stateProvider.getContextSignals({ conversationKey: key, now: ts }) : {};
        const bias = Math.max(-0.05, Math.min(0.05, Number(signals?.invocationBias) || 0));
        const threshold = Number.isFinite(Number(event.scoreThreshold)) ? Number(event.scoreThreshold) : 0.5;
        if (event.localScore + bias < threshold) {
          return this._decide(false, 'local_rule_filtered', priority, key, {
            score: event.localScore,
            bias,
            threshold,
          });
        }
      }
    }

    sess.lastWakeAt = ts;
    return this._decide(true, hasConcreteTrigger ? 'concrete_trigger' : 'scheduled_allowed', priority, key);
  }

  recordWakeOutcome(conversationKey, { producedOutput = true, now = this.now() } = {}) {
    const sess = this._getSession(conversationKey);
    if (producedOutput) {
      sess.silentStreak = 0;
      sess.lastProactiveSentAt = now;
    } else {
      sess.silentStreak += 1;
    }
  }

  _decide(allow, reason, priority, conversationKey, meta = {}) {
    const decision = { allow, reason, priority, conversationKey, ...meta };
    this.auditLog?.log('invocation', allow ? 'allow' : 'skip', decision);
    return decision;
  }
}
