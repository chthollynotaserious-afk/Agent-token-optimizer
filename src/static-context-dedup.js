/**
 * static-context-dedup.js
 * Opt-3 静态上下文去重引擎（从生产环境 bridge.js 抽离的独立参考模块）
 *
 * 核心原则：
 * 1. 全静态区块（role / identity / conversation / bili / rules 等）在同会话内计算 SHA-256 指纹，
 *    仅在首轮或达到刷新周期（私聊 25 轮 / 群聊 12 轮）时完整注入，其余轮次省略（稳定净省 ~7,718 字符/轮）。
 * 2. 半静态区块（sticker / memberImpressions）独立追踪短哈希，变更时仅增量补充，不击穿主 staticHash。
 * 3. Memory Card 增量去重：仅注入本轮新唤起的记忆 ID（【补充回忆（本会话新唤起）】）。
 */

import crypto from 'node:crypto';

export const DEFAULT_DEDUP_CONFIG = {
  privateRefreshEveryTurns: 25,
  groupRefreshEveryTurns: 12,
  maxTrackedMemoryIds: 200,
};

/**
 * 计算静态上下文区块的会话级 SHA-256 指纹
 * @param {string} sessionId
 * @param {string} staticBlock
 * @returns {string}
 */
export function computeStaticHash(sessionId, staticBlock) {
  if (!sessionId) return '';
  return crypto
    .createHash('sha256')
    .update(`v2|${sessionId}|${staticBlock ?? ''}`)
    .digest('hex');
}

/**
 * 计算半静态区块的 16 位短哈希
 * @param {string} raw
 * @returns {string}
 */
export function computeSubBlockHash(raw) {
  if (!raw) return '';
  return crypto.createHash('sha256').update(String(raw)).digest('hex').slice(0, 16);
}

/**
 * 评估当前唤醒是否可省略静态与半静态上下文
 * @param {Object} params
 * @param {string} params.key 会话键（private:xxx / group:xxx）
 * @param {string} params.sessionId 当前 DSH 会话 ID
 * @param {string} params.staticBlock 待评估的静态文本块
 * @param {Object|null} params.prevStatic st.staticContextState
 * @param {boolean} [params.dedupEnabled=true]
 * @param {string} [params.reason='message'] 唤醒原因（bootstrap 强制全量注入）
 * @param {string} [params.stickerRaw='']
 * @param {string} [params.memberImpressionsRaw='']
 * @param {Object} [params.memoryCard] { fullText, usedIds, lineById: Map }
 * @param {Object} [params.config]
 */
export function evaluateStaticDedup(params) {
  const cfg = { ...DEFAULT_DEDUP_CONFIG, ...(params.config || {}) };
  const enabled = Boolean(params.dedupEnabled ?? true) && Boolean(params.sessionId);
  const currentStaticHash = enabled ? computeStaticHash(params.sessionId, params.staticBlock) : '';
  const prevStatic = params.prevStatic || null;
  const isGroup = String(params.key || '').startsWith('group:');
  const maxRefreshTurns = Math.max(
    1,
    Number(isGroup ? cfg.groupRefreshEveryTurns : cfg.privateRefreshEveryTurns) || (isGroup ? 12 : 25)
  );

  const canOmitStatic = Boolean(
    enabled &&
      prevStatic &&
      prevStatic.sessionId === params.sessionId &&
      prevStatic.staticHash === currentStaticHash &&
      Number(prevStatic.turnsSinceFullInject || 0) < maxRefreshTurns &&
      params.reason !== 'bootstrap'
  );

  const stickerRaw = params.stickerRaw || '';
  const stickerHash = computeSubBlockHash(stickerRaw);
  const stickerLine =
    canOmitStatic && (!stickerHash || prevStatic?.stickerHash === stickerHash) ? '' : stickerRaw;

  const impressionsRaw = params.memberImpressionsRaw || '';
  const impressionsHash = computeSubBlockHash(impressionsRaw);
  const memberImpressionsLine =
    canOmitStatic && (!impressionsHash || prevStatic?.impressionsHash === impressionsHash)
      ? ''
      : impressionsRaw;

  const mc = params.memoryCard || { fullText: '', usedIds: [], lineById: new Map() };
  const usedIds = Array.isArray(mc.usedIds) ? mc.usedIds : [];
  let memoryCardLine = mc.fullText || '';
  let nextInjectedMemoryIds = usedIds.slice(-cfg.maxTrackedMemoryIds);

  if (canOmitStatic && Array.isArray(prevStatic?.injectedMemoryIds)) {
    const prevIdSet = new Set(prevStatic.injectedMemoryIds.map(String));
    const newIds = usedIds.filter((id) => !prevIdSet.has(String(id)));
    if (newIds.length === 0) {
      memoryCardLine = '';
    } else if (mc.lineById && newIds.every((id) => mc.lineById.has(String(id)))) {
      memoryCardLine = `【补充回忆（本会话新唤起）】\n${newIds
        .map((id) => mc.lineById.get(String(id)))
        .join('\n')}\n\n`;
    } else {
      memoryCardLine = mc.fullText || '';
    }
    nextInjectedMemoryIds = Array.from(new Set([...prevIdSet, ...usedIds.map(String)])).slice(
      -cfg.maxTrackedMemoryIds
    );
  }

  return {
    canOmitStatic,
    stickerLine,
    memberImpressionsLine,
    memoryCardLine,
    pendingCommit: enabled
      ? {
          sessionId: params.sessionId,
          staticHash: currentStaticHash,
          omitted: canOmitStatic,
          stickerHash,
          impressionsHash,
          injectedMemoryIds: nextInjectedMemoryIds,
        }
      : null,
  };
}

/**
 * 唤醒成功后提交静态去重状态（递增 turnsSinceFullInject 或归零）
 * @param {Object|null} prevStatic
 * @param {Object|null} pendingCommit
 * @param {number} [now=Date.now()]
 * @returns {Object|null}
 */
export function commitStaticDedupState(prevStatic, pendingCommit, now = Date.now()) {
  if (!pendingCommit) return prevStatic;
  const turnsSinceFullInject = pendingCommit.omitted
    ? Number(prevStatic?.turnsSinceFullInject || 0) + 1
    : 0;
  return {
    sessionId: pendingCommit.sessionId,
    staticHash: pendingCommit.staticHash,
    turnsSinceFullInject,
    updatedAt: now,
    stickerHash: pendingCommit.stickerHash || '',
    impressionsHash: pendingCommit.impressionsHash || '',
    injectedMemoryIds: Array.isArray(pendingCommit.injectedMemoryIds)
      ? pendingCommit.injectedMemoryIds
      : [],
  };
}
