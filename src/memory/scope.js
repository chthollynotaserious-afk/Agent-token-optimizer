/**
 * UAO Layered Memory Architecture — Strict Fail-Closed Scope Isolation (Phase 1)
 *
 * Supports multi-tenant Agent and RP isolation dimensions without collapsing
 * missing scope identifiers into a shared global namespace.
 */

export const SCOPE_DIMENSIONS = Object.freeze([
  'tenant_id',
  'runtime_instance_id',
  'user_id',
  'persona_id',
  'character_id',
  'chat_id',
  'world_id',
  'lorebook_id',
  'branch_id',
  'timeline_id',
]);

export function normalizeScope(rawScope) {
  if (!rawScope || typeof rawScope !== 'object' || Array.isArray(rawScope)) {
    return null;
  }
  const normalized = {};
  for (const dim of SCOPE_DIMENSIONS) {
    const val = rawScope[dim];
    if (typeof val === 'string' && val.trim().length > 0) {
      normalized[dim] = val.trim();
    }
  }
  return Object.keys(normalized).length > 0 ? normalized : null;
}

export function deriveScopeKey(rawScope) {
  const scope = normalizeScope(rawScope);
  if (!scope) return null;
  return SCOPE_DIMENSIONS
    .filter((dim) => scope[dim] !== undefined)
    .map((dim) => `${dim}=${encodeURIComponent(scope[dim])}`)
    .join('|');
}

/**
 * Strict Fail-Closed scope authorization:
 * - Both recordScope and requestScope must have at least one valid identifier.
 * - Any dimension present on either side must match unless explicitly authorized
 *   by `allowCrossScopePolicy` (e.g., shared world/lorebook).
 * - Sensitive records require `includeSensitive === true`.
 */
export function canAccessMemoryScope(record, requestScopeInput, opts = {}) {
  if (!record || typeof record !== 'object') return false;
  if (record.status === 'deleted') return false;
  if (record.sensitive === true && opts.includeSensitive !== true) return false;

  const recScope = normalizeScope(record.scope);
  const reqScope = normalizeScope(requestScopeInput);
  if (!recScope || !reqScope) return false;

  const allowedSharedDims = new Set(
    Array.isArray(opts.allowCrossScopeDimensions) ? opts.allowCrossScopeDimensions : []
  );

  for (const dim of SCOPE_DIMENSIONS) {
    const recVal = recScope[dim];
    const reqVal = reqScope[dim];

    if (recVal !== undefined && reqVal !== undefined) {
      if (recVal !== reqVal) return false;
      continue;
    }

    // Missing dimension on one side must not silently widen access
    if (recVal !== undefined || reqVal !== undefined) {
      if (!allowedSharedDims.has(dim)) {
        return false;
      }
    }
  }

  return true;
}
