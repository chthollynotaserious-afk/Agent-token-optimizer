/**
 * Universal Static Context Deduplication (Opt-3 evolved)
 *
 * Generalizes static & semi-static deduplication beyond Denia:
 *   - Supports arbitrary named staticBlocks & subBlocks (e.g. persona, rules, repoMap)
 *   - Supports incremental item tracking by ID (memory/RAG chunks)
 *   - Never mutates historical messages, preserving prefix KV Cache
 */

import crypto from 'node:crypto';

export const DEFAULT_UNIVERSAL_DEDUP_CONFIG = Object.freeze({
  refreshEveryTurns: 25,
  maxTrackedItemIds: 300,
});

function sha256(text) {
  return crypto.createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex');
}

export function evaluateUniversalDedup({
  sessionId,
  staticText = '',
  subBlocks = {},
  items = [],
  prevState = null,
  forceFull = false,
  config = {},
} = {}) {
  const cfg = { ...DEFAULT_UNIVERSAL_DEDUP_CONFIG, ...config };
  if (!sessionId) {
    return {
      canOmitStatic: false,
      staticText,
      emittedSubBlocks: { ...subBlocks },
      emittedItems: items,
      pendingCommit: null,
    };
  }

  const staticHash = sha256(`u1|${sessionId}|${staticText}`);
  const maxTurns = Math.max(1, Number(cfg.refreshEveryTurns) || 25);

  const canOmitStatic = Boolean(
    !forceFull
      && prevState
      && prevState.sessionId === sessionId
      && prevState.staticHash === staticHash
      && Number(prevState.turnsSinceFullInject || 0) < maxTurns
  );

  const nextSubHashes = {};
  const emittedSubBlocks = {};
  for (const [k, val] of Object.entries(subBlocks || {})) {
    const raw = String(val ?? '');
    const h = raw ? sha256(raw).slice(0, 16) : '';
    nextSubHashes[k] = h;
    if (!canOmitStatic || !h || prevState?.subHashes?.[k] !== h) {
      if (raw) emittedSubBlocks[k] = raw;
    }
  }

  const prevIds = new Set(Array.isArray(prevState?.injectedItemIds) ? prevState.injectedItemIds.map(String) : []);
  const itemList = Array.isArray(items) ? items : [];
  const emittedItems = canOmitStatic
    ? itemList.filter((it) => !prevIds.has(String(it.id)))
    : itemList;

  const nextItemIds = Array.from(
    new Set([
      ...(canOmitStatic ? prevIds : []),
      ...itemList.map((it) => String(it.id)),
    ])
  ).slice(-cfg.maxTrackedItemIds);

  return {
    canOmitStatic,
    staticText: canOmitStatic ? '' : staticText,
    emittedSubBlocks,
    emittedItems,
    pendingCommit: {
      sessionId,
      staticHash,
      omitted: canOmitStatic,
      subHashes: nextSubHashes,
      injectedItemIds: nextItemIds,
    },
  };
}

export function commitUniversalDedupState(prevState, pendingCommit, now = Date.now()) {
  if (!pendingCommit) return prevState;
  return {
    sessionId: pendingCommit.sessionId,
    staticHash: pendingCommit.staticHash,
    turnsSinceFullInject: pendingCommit.omitted ? Number(prevState?.turnsSinceFullInject || 0) + 1 : 0,
    updatedAt: now,
    subHashes: pendingCommit.subHashes || {},
    injectedItemIds: pendingCommit.injectedItemIds || [],
  };
}
