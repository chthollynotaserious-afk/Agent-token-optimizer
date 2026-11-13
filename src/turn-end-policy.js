/**
 * 回合结束实验（默认关闭，纯逻辑，无 I/O）。
 *
 * 背景：2026-11-04/05 的遥测显示，194 个有出站的回合里有 183 个在最后一次发送后
 * 还会再调用 qq_close_conversation；末次发送之后仍有 450 次模型调用。这里不直接
 * 替模型结束回合，只回答一个可验证的问题：
 *
 *   「发完最后一句、没有新未读、没有未答提问、也没有想说没说的话」时，
 *   这一轮是否已经到达一个确定性的结束状态？
 *
 * 结论只作为 hint / 观测：默认 mode=off，不改变线上行为。即使 mode=enforce，
 * 也只是在工具返回里提示「可以结束」，不会阻止模型继续发、也不会替它收尾。
 *
 * 多消息跟进是硬边界：只要还有没看过的未读（unseenUnread > 0），一律不提示结束。
 * 用户在 8 秒合并窗口内追一句，仍然应该留在同一轮里接住。
 */

export const DEFAULT_TURN_END_EXPERIMENT = Object.freeze({
  enabled: false,
  mode: 'off', // off | observe | enforce
  quietMs: 8_000,
  followUpWindowMs: 60_000,
  ownIntentLimit: 0.6,
});

const MODES = new Set(['off', 'observe', 'enforce']);
const BOOL = (v, fallback) => (typeof v === 'boolean' ? v : fallback);
const NUM = (v, fallback, min, max) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
};

export function normalizeTurnEndExperiment(raw = {}) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    ...DEFAULT_TURN_END_EXPERIMENT,
    enabled: BOOL(src.enabled, DEFAULT_TURN_END_EXPERIMENT.enabled),
    mode: MODES.has(src.mode) ? src.mode : DEFAULT_TURN_END_EXPERIMENT.mode,
    quietMs: NUM(src.quietMs, DEFAULT_TURN_END_EXPERIMENT.quietMs, 0, 120_000),
    followUpWindowMs: NUM(src.followUpWindowMs, DEFAULT_TURN_END_EXPERIMENT.followUpWindowMs, 0, 10 * 60_000),
    ownIntentLimit: Math.min(1, Math.max(0, Number(src.ownIntentLimit) || DEFAULT_TURN_END_EXPERIMENT.ownIntentLimit)),
  };
}

/**
 * @param {object} input
 * @param {boolean} [input.hasSuccessfulSend] 本轮是否至少成功发出过一条
 * @param {number} [input.unseenUnread]       本轮还没给模型看过的未读数
 * @param {number} [input.pendingThoughts]    有效「想说没说」条数
 * @param {object} [input.closure]            assessConversationClosure 的结果
 * @param {number} [input.quietMs]            最后一次发送后已经安静了多久
 * @param {object} [input.config]
 */
export function assessTurnEnd(input = {}) {
  const cfg = normalizeTurnEndExperiment(input.config);
  const signals = {
    mode: cfg.mode,
    enabled: cfg.enabled,
    hasSuccessfulSend: input.hasSuccessfulSend === true,
    unseenUnread: Math.max(0, Math.round(Number(input.unseenUnread) || 0)),
    pendingThoughts: Math.max(0, Math.round(Number(input.pendingThoughts) || 0)),
    awaitingTheirAnswer: input.closure?.signals?.awaitingTheirAnswer === true,
    ownIntent: Number(input.closure?.signals?.ownIntent) || 0,
    quietMs: Math.max(0, Math.round(Number(input.quietMs) || 0)),
    quietWindowMs: cfg.quietMs,
  };
  const deny = (reason) => ({ eligible: false, apply: false, reason, signals, hint: '' });
  if (!cfg.enabled || cfg.mode === 'off') return deny('disabled');
  if (!signals.hasSuccessfulSend) return deny('no-send');
  // 多消息跟进优先：只要还有没看过的未读，就不提示结束。
  if (signals.unseenUnread > 0) return deny('unread');
  if (signals.pendingThoughts > 0) return deny('pending-thoughts');
  if (signals.awaitingTheirAnswer) return deny('open-question');
  if (signals.ownIntent >= cfg.ownIntentLimit) return deny('own-intent');
  if (signals.quietMs < cfg.quietMs) return deny('quiet-window');
  return {
    eligible: true,
    // observe 只记录；enforce 才允许调用方把 hint 放进工具返回。
    apply: cfg.mode === 'enforce',
    reason: 'answered-and-quiet',
    signals,
    hint: '这轮已经答完，也没有新消息；可以就此结束。下次有人说话会照常唤醒，不用为了收尾再补一句。',
  };
}

/** 只有 enforce 且 eligible 时才返回可注入工具结果的提示；其余情况返回空串。 */
export function turnEndHint(decision) {
  return decision?.apply && decision?.eligible ? String(decision.hint || '') : '';
}
