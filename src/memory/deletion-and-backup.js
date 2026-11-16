/**
 * UAO Layered Memory Architecture — Auditable Deletion & Integrity-Checked Backup/Restore (Phase 1)
 */

import crypto from 'node:crypto';
import { canAccessMemoryScope, deriveScopeKey } from './scope.js';

export function computeBundleHash(records = []) {
  const canonical = JSON.stringify(records);
  return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
}

export function createExportBundle(records = [], scope = null) {
  const scopeKey = scope ? deriveScopeKey(scope) : 'all';
  const cloned = structuredClone(records);
  return {
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    scopeKey,
    count: cloned.length,
    records: cloned,
    bundleHash: computeBundleHash(cloned),
  };
}

export function verifyImportBundle(bundle) {
  if (!bundle || typeof bundle !== 'object') {
    throw new TypeError('MemoryImport: bundle must be an object');
  }
  if (bundle.schemaVersion !== 1 || !Array.isArray(bundle.records)) {
    throw new TypeError('MemoryImport: unsupported bundle schemaVersion or missing records array');
  }
  const expected = computeBundleHash(bundle.records);
  if (bundle.bundleHash !== expected) {
    throw new Error(`MemoryImportIntegrityError: bundleHash mismatch (expected ${expected}, got ${bundle.bundleHash})`);
  }
  return true;
}

/**
 * Execute auditable deletion with optional derived-record propagation.
 * Never logs private memory content to AuditLog.
 */
export function executeAuditableDeletion(storeMap, {
  selector = {},
  scope,
  policy = {},
  auditLog = null,
  opts = {},
} = {}) {
  const scopeKey = deriveScopeKey(scope);
  if (!scopeKey) {
    throw new TypeError('MemoryDelete: valid scope is required');
  }

  const propagateDerived = policy.propagateDerived !== false;
  const actor = String(policy.actor || 'system');
  const reason = String(policy.reason || 'explicit_delete');
  const targetIds = new Set(Array.isArray(selector.ids) ? selector.ids.map(String) : []);

  const deletedIds = [];
  const propagatedIds = [];
  const nowIso = new Date().toISOString();

  for (const [id, record] of storeMap.entries()) {
    if (!canAccessMemoryScope(record, scope, opts)) continue;
    const matchesId = targetIds.size === 0 || targetIds.has(id);
    const matchesKind = !selector.kind || record.kind === selector.kind;
    if (matchesId && matchesKind) {
      record.status = 'deleted';
      record.updated_at = nowIso;
      deletedIds.push(id);
    }
  }

  if (propagateDerived && deletedIds.length > 0) {
    const deletedSet = new Set(deletedIds);
    for (const [id, record] of storeMap.entries()) {
      if (record.status === 'deleted') continue;
      if (!canAccessMemoryScope(record, scope, opts)) continue;
      const refs = Array.isArray(record.source_refs) ? record.source_refs : [];
      if (refs.some((ref) => deletedSet.has(ref))) {
        record.status = 'deleted';
        record.updated_at = nowIso;
        propagatedIds.push(id);
      }
    }
  }

  if (auditLog && typeof auditLog.log === 'function') {
    auditLog.log('memory', 'delete', {
      actor,
      reason,
      scopeKey,
      deletedCount: deletedIds.length,
      propagatedCount: propagatedIds.length,
      deletedIds,
      propagatedIds,
    });
  }

  return {
    deletedIds,
    propagatedIds,
    totalAffected: deletedIds.length + propagatedIds.length,
  };
}
