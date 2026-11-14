/**
 * session-rotation.js
 * Opt-1 无损会话轮转引擎（从生产环境 bridge.js 抽离的独立参考模块）
 *
 * 核心原则：
 * 1. 触发阈值：私聊 30 轮 / 群聊 25 轮 / 闲置 >4 小时 / 上下文 >= 120k Tokens。
 * 2. 弥补方案一（原生滑窗交接）：截取末尾 4~6 条真实对话原文（每条截断 150 字），绝不写入 valence/arousal 等情绪数值。
 * 3. 弥补方案二（轮转前自动沉淀钩子 Auto-Flush Hook）：通过 `onBeforeRotate` 在清空旧会话前触发记忆提取/再巩固。
 * 4. 弥补方案四（按需调阅提示）：提示新会话可主动检索更早历史。
 * 5. 回滚保障：物理保留旧会话指针于 sessionHistory（最多 20 条），不调用 delete/archive，并重置 staticContextState。
 */

export const DEFAULT_ROTATION_LIMITS = {
  privateMaxTurns: 30,
  groupMaxTurns: 25,
  maxIdleMs: 4 * 3600 * 1000,
  maxContextTokens: 120000,
  idleTokenThreshold: 70000,
  tailWindowSize: 6,
  tailLineMaxChars: 150,
  maxHistoryEntries: 20,
};

/**
 * 判断会话是否达到 Opt-1 轮转条件
 * @param {string} key 会话键（如 private:xxx / group:xxx）
 * @param {Object} st 会话运行态
 * @param {Object} [opts]
 * @param {number} [opts.currentInputTokens=0] 当前会话最近一次输入 Token 数
 * @param {number} [opts.now=Date.now()]
 * @param {Object} [opts.limits=DEFAULT_ROTATION_LIMITS]
 * @returns {{ shouldRotate: boolean, reason: string }}
 */
export function evaluateSessionRotation(key, st, opts = {}) {
  if (!st || !opts.currentSessionId) {
    return { shouldRotate: false, reason: '' };
  }
  const limits = { ...DEFAULT_ROTATION_LIMITS, ...(opts.limits || {}) };
  const isPrivate = String(key).startsWith('private:');
  const maxTurns = isPrivate ? limits.privateMaxTurns : limits.groupMaxTurns;
  const turns = Number(st.sessionTurns) || 0;
  const lastActive = Number(st.lastActionAt || st.lastAiReplyAt) || 0;
  const curTokens = Number(opts.currentInputTokens) || 0;
  const now = Number(opts.now) || Date.now();

  if (curTokens >= limits.maxContextTokens) {
    return { shouldRotate: true, reason: `tokens_limit_${Math.round(curTokens / 1000)}k` };
  }
  if (turns >= maxTurns) {
    return { shouldRotate: true, reason: `turns_limit_${turns}` };
  }
  if (
    lastActive > 0 &&
    now - lastActive > limits.maxIdleMs &&
    (turns >= 1 || curTokens >= limits.idleTokenThreshold)
  ) {
    return { shouldRotate: true, reason: `idle_timeout_${Math.round((now - lastActive) / 3600000)}h` };
  }
  return { shouldRotate: false, reason: '' };
}

/**
 * 构建无损交接滑窗摘要（Tail Buffer + 历史按需调阅提示）
 * @param {Array<Object>} recentMessages
 * @param {Object} [opts]
 * @returns {string}
 */
export function buildHandoffSummary(recentMessages = [], opts = {}) {
  const windowSize = opts.tailWindowSize ?? DEFAULT_ROTATION_LIMITS.tailWindowSize;
  const maxChars = opts.tailLineMaxChars ?? DEFAULT_ROTATION_LIMITS.tailLineMaxChars;
  const selfId = opts.selfId;
  const botName = opts.botName || 'Denia';

  const rawRecent = (Array.isArray(recentMessages) ? recentMessages : []).slice(-windowSize);
  const tailLines = rawRecent
    .map((m) => {
      const sender = m.sender || (selfId && m.userId === selfId ? botName : '对方');
      const text = String(m.rawMessage || m.text || '').slice(0, maxChars).trim();
      return text ? `[${sender}]: ${text}` : null;
    })
    .filter(Boolean);

  let summary = '';
  if (tailLines.length > 0) {
    summary =
      '【无损交接滑窗】上轮会话末尾真实切片（保持话题与指代连续）：\n' +
      tailLines.join('\n');
  }
  summary +=
    '\n【早前历史调阅提示】若对方提及今天更早或之前的话题，你可以主动调用历史检索工具查询，无需凭空猜测。';
  summary +=
    '\n【协议提醒】当前为二代仿真模式，纯文本输出仅作内部思考、不会发送到 QQ；所有对外发言必须调用 qq_send_message 等发送工具。';

  return summary;
}

/**
 * 执行无损会话轮转（保留旧会话历史指针，重置轮数与静态上下文状态）
 * @param {string} key
 * @param {Object} st 会话状态对象（将被就地更新）
 * @param {Object} state 全局会话映射状态（含 sessions 与 sessionHistory）
 * @param {Object} [opts]
 * @returns {boolean} 是否发生轮转
 */
export function rotateSession(key, st, state, opts = {}) {
  const currentSessionId = state?.sessions?.[key];
  const { shouldRotate, reason } = evaluateSessionRotation(key, st, {
    ...opts,
    currentSessionId,
  });
  if (!shouldRotate) return false;

  const now = Number(opts.now) || Date.now();
  const maxHistory = opts.limits?.maxHistoryEntries ?? DEFAULT_ROTATION_LIMITS.maxHistoryEntries;

  // 弥补方案二（Pre-Rotation Auto-Flush Hook）：轮转截断前触发记忆沉淀/再巩固回调
  if (typeof opts.onBeforeRotate === 'function') {
    opts.onBeforeRotate({
      key,
      st,
      fromSessionId: currentSessionId,
      reason,
      now,
      recentMessages: Array.isArray(st.recentMessages) ? st.recentMessages : [],
    });
  }

  st.pendingHandoff = {
    summary: buildHandoffSummary(st.recentMessages, opts),
    fromSessionId: currentSessionId,
    rotatedAt: now,
  };

  if (!state.sessionHistory) state.sessionHistory = {};
  if (!state.sessionHistory[key]) state.sessionHistory[key] = [];
  state.sessionHistory[key].push({
    sessionId: currentSessionId,
    rotatedAt: now,
    turns: Number(st.sessionTurns) || 0,
    reason,
  });
  if (state.sessionHistory[key].length > maxHistory) {
    state.sessionHistory[key].shift();
  }

  st.sessionTurns = 0;
  st.staticContextState = null;
  delete state.sessions[key];
  return true;
}

/**
 * 在新会话首轮消费并清空 pendingHandoff
 * @param {Object} st
 * @returns {string}
 */
export function consumePendingHandoff(st) {
  if (!st?.pendingHandoff?.summary) return '';
  const handoffLine = st.pendingHandoff.summary + '\n\n';
  st.pendingHandoff = null;
  return handoffLine;
}
