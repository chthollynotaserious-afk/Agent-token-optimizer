/**
 * UAO Layered Memory Architecture — Canonical Record Schema & Immutability Guards (Phase 1)
 */

import crypto from 'node:crypto';

export const MEMORY_KINDS = Object.freeze([
  'working',
  'episodic',
  'semantic',
  'narrative_state',
  'associative',
  'index',
  'summary',
  'checkpoint',
]);

export const DERIVED_MEMORY_KINDS = new Set([
  'semantic',
  'narrative_state',
  'associative',
  'index',
  'summary',
  'checkpoint',
]);

export const EPISTEMIC_STATUSES = Object.freeze([
  'observed',
  'user_asserted',
  'character_belief',
  'inferred',
  'unknown',
  'disputed',
]);

export const RECORD_STATUSES = Object.freeze([
  'active',
  'archived',
  'superseded',
  'deleted',
]);

export function redactMemorySecrets(text) {
  return String(text ?? '')
    .replace(/Bearer\s+[A-Za-z0-9._\-+/=]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9]{16,})\b/g, '[REDACTED_SECRET]')
    .replace(/(api[_-]?key|token|secret|password|cookie|authorization)\s*[:=]\s*(['"]?)[^\s,'";\n]+\2/gi, '$1=[REDACTED]');
}

export function computeContentHash(content) {
  const normalized = typeof content === 'string' ? content : JSON.stringify(content ?? '');
  return crypto.createHash('sha256').update(normalized, 'utf8').digest('hex');
}

export function createMemoryRecord(input = {}) {
  if (!input || typeof input !== 'object') {
    throw new TypeError('MemoryRecord: input must be an object');
  }

  const kind = String(input.kind || '').trim();
  if (!MEMORY_KINDS.includes(kind)) {
    throw new TypeError(`MemoryRecord: invalid kind "${kind}"`);
  }

  const epistemicStatus = String(input.epistemic_status || 'observed').trim();
  if (!EPISTEMIC_STATUSES.includes(epistemicStatus)) {
    throw new TypeError(`MemoryRecord: invalid epistemic_status "${epistemicStatus}"`);
  }

  const status = String(input.status || 'active').trim();
  if (!RECORD_STATUSES.includes(status)) {
    throw new TypeError(`MemoryRecord: invalid status "${status}"`);
  }

  const scope = input.scope && typeof input.scope === 'object' ? { ...input.scope } : null;
  if (!scope || Object.keys(scope).length === 0) {
    throw new TypeError('MemoryRecord: non-empty scope object is required');
  }

  const sourceRefs = Array.isArray(input.source_refs)
    ? input.source_refs.map((r) => String(r).trim()).filter(Boolean)
    : [];

  if (DERIVED_MEMORY_KINDS.has(kind) && sourceRefs.length === 0) {
    throw new TypeError(`MemoryRecord: derived kind "${kind}" requires at least one source_ref`);
  }

  const rawContent = input.content;
  const content = typeof rawContent === 'string'
    ? redactMemorySecrets(rawContent)
    : rawContent;

  if (content === undefined || content === null || content === '') {
    throw new TypeError('MemoryRecord: content is required');
  }

  const nowIso = new Date().toISOString();
  const id = input.id ? String(input.id).trim() : `mem_${crypto.randomUUID()}`;
  const confidenceRaw = input.confidence === undefined ? (epistemicStatus === 'observed' ? 1.0 : 0.7) : Number(input.confidence);
  const confidence = Number.isFinite(confidenceRaw) ? Math.min(1, Math.max(0, confidenceRaw)) : 0.5;

  return {
    id,
    kind,
    scope,
    content,
    source_refs: sourceRefs,
    provenance: {
      source_type: input.provenance?.source_type || (kind === 'episodic' ? 'host_message' : 'derived'),
      source_id: input.provenance?.source_id || sourceRefs[0] || id,
      extractor: input.provenance?.extractor || 'uao-memory-foundation',
      created_by: input.provenance?.created_by || 'system',
    },
    epistemic_status: epistemicStatus,
    confidence,
    sensitive: Boolean(input.sensitive),
    valid_time: {
      from: input.valid_time?.from || nowIso,
      to: input.valid_time?.to ?? null,
    },
    created_at: input.created_at || nowIso,
    updated_at: input.updated_at || nowIso,
    version: Number.isInteger(input.version) && input.version >= 1 ? input.version : 1,
    status,
    retention_class: String(input.retention_class || 'standard'),
    content_hash: computeContentHash(content),
  };
}

/**
 * Guard: raw episodic records are authoritative evidence and cannot be overwritten
 * by derived updates. Derived updates must also provide source_refs and a reason.
 */
export function assertDerivedUpdateAllowed(existingRecord, patch = {}) {
  if (!existingRecord || typeof existingRecord !== 'object') {
    throw new TypeError('DerivedUpdate: existingRecord is required');
  }
  if (existingRecord.kind === 'episodic') {
    throw new Error('DerivedUpdateDenied: raw episodic records are immutable and cannot be overwritten');
  }
  if (!DERIVED_MEMORY_KINDS.has(existingRecord.kind)) {
    throw new Error(`DerivedUpdateDenied: kind "${existingRecord.kind}" does not support derived updates`);
  }
  if (!patch || typeof patch !== 'object') {
    throw new TypeError('DerivedUpdate: patch object is required');
  }
  if (typeof patch.reason !== 'string' || !patch.reason.trim()) {
    throw new TypeError('DerivedUpdate: non-empty reason is required for versioned auditability');
  }
}
