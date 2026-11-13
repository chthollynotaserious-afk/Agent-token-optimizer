/**
 * Pure proactive patrol gate & exponential backoff (Denia Opt-4/Opt-5, rule-only).
 * Implements:
 *   1) B-class concrete reason pass (unread, pendingThoughts, activeTopics, awaitingAnswer, dueCommitments)
 *   2) Single cold-idle spontaneous check-in during active hours, followed by hard no-reply lock
 *      once Denia sends proactively until a peer message unlocks it ("对方没回就停敲")
 *   3) Exponential backoff delay on silent proactive wakes / Class-A empty skips
 */

const TERMINAL_COMMITMENT_STATES = new Set(['completed', 'failed', 'blocked']);

const DEFAULTS = Object.freeze({
  topicFollowupMinMs: 30 * 60_000,
  topicFollowupMaxAgeMs: 24 * 3600_000,
  thoughtRecheckCooldownMs: 6 * 3600_000,
  awaitingMaxAgeMs: 24 * 3600_000,
  maxBackoffMs: 8 * 3600_000,
  maxSilentExponent: 6,
});

function finite(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** Collect all currently valid B-class concrete triggers without mutating state. */
export function findProactiveConcreteReasons({
  st,
  now,
  commitments = [],
  gateCfg = {},
} = {}) {
  const cfg = { ...DEFAULTS, ...gateCfg };
  const curNow = finite(now, Date.now());
  const reasons = [];
  const triggeredTopicIndices = [];
  const triggeredThoughtIndices = [];

  if (Array.isArray(st?.unread) && st.unread.length > 0) {
    reasons.push('unread');
  }

  if (Array.isArray(commitments) && commitments.some((c) => c && !TERMINAL_COMMITMENT_STATES.has(c.state) && finite(c.dueAt, 0) > 0 && curNow >= finite(c.dueAt, 0))) {
    reasons.push('dueCommitment');
  }

  const thoughts = Array.isArray(st?.pendingThoughts) ? st.pendingThoughts : [];
  for (let i = 0; i < thoughts.length; i += 1) {
    const t = thoughts[i];
    if (!t || typeof t !== 'object') continue;
    const expiresAt = finite(t.expiresAt, 0);
    if (expiresAt > 0 && curNow >= expiresAt) continue;
    const checkedAt = finite(t.lastProactiveCheckedAt, 0);
    if (checkedAt > 0 && (curNow - checkedAt) < cfg.thoughtRecheckCooldownMs) continue;
    triggeredThoughtIndices.push(i);
  }
  if (triggeredThoughtIndices.length > 0) reasons.push('pendingThought');

  const topics = Array.isArray(st?.activeTopics) ? st.activeTopics : [];
  for (let i = 0; i < topics.length; i += 1) {
    const t = topics[i];
    if (!t || typeof t !== 'object') continue;
    const mentionAt = finite(t.lastMentionAt || t.updatedAt, 0);
    const followedAt = finite(t.followedUpAt || t.lastProactiveCheckedAt, 0);
    if (followedAt > 0 && followedAt >= mentionAt) continue;
    if (t.pendingQuestion === true) {
      if (mentionAt === 0 || (curNow - mentionAt) <= cfg.topicFollowupMaxAgeMs) {
        triggeredTopicIndices.push(i);
      }
      continue;
    }
    if (mentionAt > 0 && (curNow - mentionAt) >= cfg.topicFollowupMinMs && (curNow - mentionAt) <= cfg.topicFollowupMaxAgeMs) {
      triggeredTopicIndices.push(i);
    }
  }
  if (triggeredTopicIndices.length > 0) reasons.push('activeTopic');

  const closure = st?.closure;
  const lastProactiveWakeAt = finite(st?.lastProactiveWakeAt, 0);
  if (
    closure
    && closure.signals?.awaitingTheirAnswer === true
    && closure.reopened !== true
    && finite(closure.at, 0) > 0
    && (curNow - finite(closure.at, 0)) <= cfg.awaitingMaxAgeMs
    && lastProactiveWakeAt < finite(closure.at, 0)
  ) {
    reasons.push('awaitingAnswer');
  }

  return {
    reasons,
    triggeredTopicIndices,
    triggeredThoughtIndices,
  };
}

/**
 * Evaluate whether a proactive timer check should wake the model.
 * Pure decision function: returns { allow, kind, reason, reasons, silent, noReplyLocked, silentStreak, ... }.
 */
export function evaluateProactiveGate({
  st,
  now,
  commitments = [],
  cfgProactive = {},
  gateCfg = {},
  activeHoursOk = true,
  busy = false,
  prob = 0,
  draw = 1,
} = {}) {
  const curNow = finite(now, Date.now());
  const lastIncomingAt = finite(st?.lastIncomingAt, 0);
  const lastProactiveWakeAt = finite(st?.lastProactiveWakeAt, 0);
  const lastProactiveSentAt = finite(st?.lastProactiveSentAt, 0);
  const lastProactiveSilentAt = finite(st?.lastProactiveSilentAt, 0);
  const silentStreak = Math.max(0, finite(st?.proactiveSilentStreak, 0));
  const idleThresholdMs = Math.max(0, finite(cfgProactive?.idleThresholdMs, 15 * 60_000));
  const cooldownMs = Math.max(0, finite(cfgProactive?.cooldownMs, 0));
  const idleMs = lastIncomingAt > 0 ? Math.max(0, curNow - lastIncomingAt) : 0;
  const sinceProactiveWakeMs = lastProactiveWakeAt > 0 ? Math.max(0, curNow - lastProactiveWakeAt) : Infinity;
  const noReplyLocked = lastProactiveSentAt > 0 && lastProactiveSentAt >= lastIncomingAt;

  const baseMeta = {
    noReplyLocked,
    silentStreak,
    idleMs,
    sinceProactiveWakeMs,
  };

  if (activeHoursOk !== true) {
    return { allow: false, kind: 'skip', reason: 'outside-active-hours', reasons: [], triggeredTopicIndices: [], triggeredThoughtIndices: [], silent: true, ...baseMeta };
  }

  if (busy === true) {
    return { allow: false, kind: 'skip', reason: 'busy', reasons: [], triggeredTopicIndices: [], triggeredThoughtIndices: [], silent: true, ...baseMeta };
  }

  const concrete = findProactiveConcreteReasons({ st, now: curNow, commitments, gateCfg });
  const hasUrgent = concrete.reasons.includes('unread') || concrete.reasons.includes('dueCommitment');

  if (hasUrgent) {
    const urgentMinGap = Math.max(cooldownMs, 60_000);
    if (sinceProactiveWakeMs < urgentMinGap) {
      return { allow: false, kind: 'skip', reason: 'cooldown', ...concrete, silent: true, ...baseMeta };
    }
    return { allow: true, kind: 'concrete', reason: concrete.reasons[0], ...concrete, silent: false, ...baseMeta };
  }

  // Peer has not replied since Denia's last proactive message: stop knocking until unlocked.
  if (noReplyLocked) {
    return { allow: false, kind: 'locked', reason: 'no-reply-lock', reasons: [], triggeredTopicIndices: [], triggeredThoughtIndices: [], silent: true, ...baseMeta };
  }

  if (concrete.reasons.length > 0) {
    if (sinceProactiveWakeMs < cooldownMs) {
      return { allow: false, kind: 'skip', reason: 'cooldown', ...concrete, silent: true, ...baseMeta };
    }
    if (lastIncomingAt > 0 && idleMs < idleThresholdMs) {
      return { allow: false, kind: 'skip', reason: 'not-idle', ...concrete, silent: true, ...baseMeta };
    }
    return { allow: true, kind: 'concrete', reason: concrete.reasons[0], ...concrete, silent: false, ...baseMeta };
  }

  // Pure spontaneous Class-A check: require prior conversation activity + idle + cooldown.
  if (lastIncomingAt <= 0) {
    return { allow: false, kind: 'skip', reason: 'no-incoming-history', reasons: [], triggeredTopicIndices: [], triggeredThoughtIndices: [], silent: true, ...baseMeta };
  }
  if (idleMs < idleThresholdMs) {
    return { allow: false, kind: 'skip', reason: 'not-idle', reasons: [], triggeredTopicIndices: [], triggeredThoughtIndices: [], silent: true, ...baseMeta };
  }
  if (sinceProactiveWakeMs < cooldownMs) {
    return { allow: false, kind: 'skip', reason: 'cooldown', reasons: [], triggeredTopicIndices: [], triggeredThoughtIndices: [], silent: true, ...baseMeta };
  }

  // Already had 1 spontaneous check-in during this silence (either woke or stayed silent): skip Class-A.
  const alreadyCheckedThisSilence = silentStreak > 0
    || (lastProactiveWakeAt > 0 && lastProactiveWakeAt >= lastIncomingAt)
    || (lastProactiveSilentAt > 0 && lastProactiveSilentAt >= lastIncomingAt);

  if (alreadyCheckedThisSilence) {
    return { allow: false, kind: 'backoff', reason: 'class-a-empty-idle', reasons: [], triggeredTopicIndices: [], triggeredThoughtIndices: [], silent: true, ...baseMeta };
  }

  // First cold-idle opportunity since last incoming message: run existing probability draw.
  if (finite(draw, 1) < finite(prob, 0)) {
    return { allow: true, kind: 'spontaneous', reason: 'cold-idle-spontaneous', reasons: ['cold-idle-spontaneous'], triggeredTopicIndices: [], triggeredThoughtIndices: [], silent: false, ...baseMeta };
  }

  return { allow: false, kind: 'skip', reason: 'probability-miss', reasons: [], triggeredTopicIndices: [], triggeredThoughtIndices: [], silent: true, ...baseMeta };
}

/**
 * Compute next check delay with exponential backoff on silent streak or locked cap.
 */
export function computeProactiveDelayMs({
  minMs = 30 * 60_000,
  maxMs = 90 * 60_000,
  silentStreak = 0,
  noReplyLocked = false,
  maxBackoffMs = DEFAULTS.maxBackoffMs,
  rand = 0.5,
} = {}) {
  const min = Math.max(60_000, finite(minMs, 30 * 60_000));
  const max = Math.max(min, finite(maxMs, 90 * 60_000));
  const r = Math.min(1, Math.max(0, finite(rand, 0.5)));
  const base = Math.floor(min + r * (max - min));
  const cap = Math.max(max, finite(maxBackoffMs, DEFAULTS.maxBackoffMs));
  if (noReplyLocked) return cap;
  const streak = Math.max(0, Math.floor(finite(silentStreak, 0)));
  if (streak === 0) return base;
  const exponent = Math.min(streak, DEFAULTS.maxSilentExponent);
  return Math.min(cap, Math.round(base * Math.pow(2, exponent)));
}

export const __test = { DEFAULTS };
