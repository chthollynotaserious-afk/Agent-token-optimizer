/**
 * Universal Context Selector & Fail-Closed Scope ACL
 *
 * Decoupled from Denia platforms (qq/bili/pet), supporting multi-tenant,
 * multi-channel, and role-scoped context selection with deterministic privacy boundaries.
 */

export function canAccessScope(record, requestCtx) {
  if (!record || typeof record !== 'object') return false;
  if (!requestCtx || typeof requestCtx !== 'object') return false;
  if (!requestCtx.tenantId && !requestCtx.scope && !requestCtx.platform) return false;

  if (record.superseded === true || Boolean(record.supersededBy)) return false;
  if (record.expiresAt) {
    const exp = Date.parse(String(record.expiresAt));
    if (Number.isFinite(exp) && exp < (Number(requestCtx.now) || Date.now())) return false;
  }

  if (record.sensitive === true && requestCtx.includeSensitive !== true) return false;

  // Tenant isolation (strict when either specifies tenantId)
  if (record.tenantId && requestCtx.tenantId && record.tenantId !== requestCtx.tenantId) {
    return false;
  }
  if (record.tenantId && !requestCtx.tenantId) return false;

  const audience = record.audience || 'private';
  if (audience === 'public' || audience === 'shared') {
    if (Array.isArray(record.allowedScopes) && record.allowedScopes.length > 0) {
      return Boolean(requestCtx.scope && record.allowedScopes.includes(requestCtx.scope));
    }
    return true;
  }

  if (audience === 'admin' || audience === 'owner') {
    if (requestCtx.isAdmin !== true && requestCtx.isOwner !== true) return false;
    if (record.scope && requestCtx.scope && record.scope !== requestCtx.scope && requestCtx.isAdmin !== true) {
      return false;
    }
    return true;
  }

  // Default private/scoped isolation: must match exact scope
  if (record.scope && requestCtx.scope && record.scope === requestCtx.scope) {
    return true;
  }

  // Fail-Closed default
  return false;
}

function redactText(text) {
  return String(text ?? '')
    .replace(/\b(?:sk-[a-zA-Z0-9_-]{12,}|ghp_[a-zA-Z0-9]{16,}|Bearer\s+[a-zA-Z0-9._-]+)\b/gi, '[REDACTED_SECRET]');
}

export function selectUniversalContext({
  records = [],
  requestCtx = {},
  maxChars = 4000,
  priorityBoostById = {},
} = {}) {
  const visibleRecords = (Array.isArray(records) ? records : []).filter((r) => canAccessScope(r, requestCtx));

  // Deduplicate versioned keys (keep highest effectiveFrom / createdAt)
  const latestByKey = new Map();
  for (const r of visibleRecords) {
    if (!r.key) continue;
    const prev = latestByKey.get(r.key);
    const curEff = String(r.effectiveFrom || r.createdAt || '');
    const prevEff = String(prev?.effectiveFrom || prev?.createdAt || '');
    if (!prev || curEff >= prevEff) latestByKey.set(r.key, r);
  }

  const deduped = visibleRecords.filter((r) => !r.key || latestByKey.get(r.key) === r);

  // Rank: pinned first, then importance + optional StateProvider boost
  deduped.sort((a, b) => {
    const pinDiff = (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0);
    if (pinDiff !== 0) return pinDiff;
    const scoreA = (Number(a.importance) || 0) + (Number(priorityBoostById[a.id]) || 0);
    const scoreB = (Number(b.importance) || 0) + (Number(priorityBoostById[b.id]) || 0);
    return scoreB - scoreA;
  });

  const selected = [];
  const seenIds = new Set();
  let usedChars = 0;

  for (const r of deduped) {
    const id = String(r.id || r.recordId || '');
    if (!id || seenIds.has(id)) continue;
    const text = redactText(r.text || '').trim();
    if (!text) continue;
    const line = `- ${r.title ? `[${r.title}] ` : ''}${text}`;
    if (!r.pinned && maxChars > 0 && usedChars + line.length + 1 > maxChars) continue;
    seenIds.add(id);
    selected.push({ id, line, record: r });
    usedChars += line.length + 1;
  }

  return {
    selected,
    usedIds: [...seenIds],
    text: selected.map((s) => s.line).join('\n'),
    usedChars,
  };
}
