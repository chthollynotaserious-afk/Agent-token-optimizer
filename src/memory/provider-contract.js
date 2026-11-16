/**
 * UAO Layered Memory Architecture — Provider Contract & Reference In-Memory Provider (Phase 1)
 */

import {
  assertDerivedUpdateAllowed,
  computeContentHash,
  createMemoryRecord,
  redactMemorySecrets,
} from './schema.js';
import { canAccessMemoryScope, deriveScopeKey, normalizeScope } from './scope.js';
import {
  createExportBundle,
  executeAuditableDeletion,
  verifyImportBundle,
} from './deletion-and-backup.js';

export class MemoryProvider {
  capabilities() {
    throw new Error('MemoryProvider.capabilities() must be implemented');
  }

  async health() {
    throw new Error('MemoryProvider.health() must be implemented');
  }

  async writeRecord() {
    throw new Error('MemoryProvider.writeRecord() must be implemented');
  }

  async readRecord() {
    throw new Error('MemoryProvider.readRecord() must be implemented');
  }

  async queryRecords() {
    throw new Error('MemoryProvider.queryRecords() must be implemented');
  }

  async updateDerivedRecord() {
    throw new Error('MemoryProvider.updateDerivedRecord() must be implemented');
  }

  async listSources() {
    throw new Error('MemoryProvider.listSources() must be implemented');
  }

  async deleteRecords() {
    throw new Error('MemoryProvider.deleteRecords() must be implemented');
  }

  async exportBundle() {
    throw new Error('MemoryProvider.exportBundle() must be implemented');
  }

  async importBundle() {
    throw new Error('MemoryProvider.importBundle() must be implemented');
  }
}

export class InMemoryMemoryProvider extends MemoryProvider {
  constructor({ auditLog = null } = {}) {
    super();
    this.auditLog = auditLog;
    this.records = new Map();
    this.versionHistory = new Map();
  }

  capabilities() {
    return Object.freeze({
      provider: 'in-memory',
      scopeIsolation: true,
      versionedDerivedUpdates: true,
      auditableDeletion: true,
      deletionPropagation: true,
      exportImport: true,
      vectorSearch: false,
      persistent: false,
    });
  }

  async health() {
    return {
      ok: true,
      provider: 'in-memory',
      recordCount: this.records.size,
    };
  }

  async writeRecord(input, opts = {}) {
    const scope = normalizeScope(input?.scope);
    if (!scope) {
      throw new TypeError('MemoryWrite: valid non-empty scope is required');
    }
    const record = createMemoryRecord({ ...input, scope });
    if (this.records.has(record.id)) {
      throw new Error(`MemoryWriteConflict: record "${record.id}" already exists`);
    }
    this.records.set(record.id, record);
    this.versionHistory.set(record.id, []);

    if (this.auditLog && typeof this.auditLog.log === 'function') {
      this.auditLog.log('memory', 'write', {
        id: record.id,
        kind: record.kind,
        scopeKey: deriveScopeKey(record.scope),
        epistemic_status: record.epistemic_status,
      });
    }
    return structuredClone(record);
  }

  async readRecord(id, scope, opts = {}) {
    const record = this.records.get(String(id));
    if (!record) return null;
    if (!canAccessMemoryScope(record, scope, opts)) {
      return null;
    }
    return structuredClone(record);
  }

  async queryRecords(query = {}, scope, opts = {}) {
    const reqScope = normalizeScope(scope);
    if (!reqScope) return [];

    // Scope-first filtering BEFORE any ranking or keyword matching
    const authorized = [];
    for (const record of this.records.values()) {
      if (!canAccessMemoryScope(record, reqScope, opts)) continue;
      if (query.kind && record.kind !== query.kind) continue;
      if (query.status && record.status !== query.status) continue;
      if (!query.status && record.status !== 'active') continue;
      authorized.push(record);
    }

    const term = typeof query.text === 'string' ? query.text.trim().toLowerCase() : '';
    const filtered = term
      ? authorized.filter((r) => {
          const hay = typeof r.content === 'string' ? r.content : JSON.stringify(r.content);
          return hay.toLowerCase().includes(term);
        })
      : authorized;

    filtered.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
    const limit = Number.isInteger(query.limit) && query.limit > 0 ? query.limit : 50;
    return filtered.slice(0, limit).map((r) => structuredClone(r));
  }

  async updateDerivedRecord(id, patch = {}, expectedVersion, scope, opts = {}) {
    const existing = this.records.get(String(id));
    if (!existing || !canAccessMemoryScope(existing, scope, opts)) {
      throw new Error(`MemoryUpdateNotFound: record "${id}" not found in authorized scope`);
    }

    assertDerivedUpdateAllowed(existing, patch);

    if (existing.version !== expectedVersion) {
      throw new Error(
        `MemoryVersionConflict: expected version ${expectedVersion}, actual ${existing.version}`
      );
    }

    // Snapshot previous version before mutating (transactional safety)
    const previousSnapshot = structuredClone(existing);
    const history = this.versionHistory.get(existing.id) || [];

    try {
      const nextContent = patch.content !== undefined
        ? (typeof patch.content === 'string' ? redactMemorySecrets(patch.content) : patch.content)
        : existing.content;
      const nextRefs = Array.isArray(patch.source_refs) && patch.source_refs.length > 0
        ? [...new Set([...existing.source_refs, ...patch.source_refs.map(String)])]
        : existing.source_refs;

      const updated = {
        ...existing,
        content: nextContent,
        content_hash: computeContentHash(nextContent),
        source_refs: nextRefs,
        epistemic_status: patch.epistemic_status || existing.epistemic_status,
        confidence: patch.confidence !== undefined ? Number(patch.confidence) : existing.confidence,
        status: patch.status || existing.status,
        version: existing.version + 1,
        updated_at: new Date().toISOString(),
        last_update_reason: patch.reason.trim(),
      };

      history.push({
        ...previousSnapshot,
        archived_reason: patch.reason.trim(),
      });
      this.versionHistory.set(existing.id, history);
      this.records.set(existing.id, updated);

      if (this.auditLog && typeof this.auditLog.log === 'function') {
        this.auditLog.log('memory', 'update_derived', {
          id: updated.id,
          fromVersion: previousSnapshot.version,
          toVersion: updated.version,
          reason: patch.reason.trim(),
          scopeKey: deriveScopeKey(updated.scope),
        });
      }

      return structuredClone(updated);
    } catch (err) {
      // Rollback to previous known-good state
      this.records.set(existing.id, previousSnapshot);
      throw err;
    }
  }

  async getVersionHistory(id, scope, opts = {}) {
    const existing = this.records.get(String(id));
    if (!existing || !canAccessMemoryScope(existing, scope, opts)) {
      return [];
    }
    return structuredClone(this.versionHistory.get(String(id)) || []);
  }

  async listSources(scope, opts = {}) {
    const reqScope = normalizeScope(scope);
    if (!reqScope) return [];
    const sources = new Set();
    for (const record of this.records.values()) {
      if (!canAccessMemoryScope(record, reqScope, opts)) continue;
      if (record.kind === 'episodic') sources.add(record.id);
      for (const ref of record.source_refs || []) sources.add(ref);
    }
    return [...sources];
  }

  async deleteRecords(selector = {}, scope, policy = {}, opts = {}) {
    return executeAuditableDeletion(this.records, {
      selector,
      scope,
      policy,
      auditLog: this.auditLog,
      opts,
    });
  }

  async exportBundle(scope, opts = {}) {
    const reqScope = normalizeScope(scope);
    if (!reqScope) {
      throw new TypeError('MemoryExport: valid scope is required');
    }
    const matching = [];
    for (const record of this.records.values()) {
      if (canAccessMemoryScope(record, reqScope, opts)) {
        matching.push(record);
      }
    }
    return createExportBundle(matching, reqScope);
  }

  async importBundle(bundle, opts = {}) {
    verifyImportBundle(bundle);
    let imported = 0;
    for (const rec of bundle.records) {
      const validated = createMemoryRecord(rec);
      if (opts.overwrite === true || !this.records.has(validated.id)) {
        this.records.set(validated.id, validated);
        if (!this.versionHistory.has(validated.id)) {
          this.versionHistory.set(validated.id, []);
        }
        imported += 1;
      }
    }
    return { imported, total: bundle.records.length };
  }
}
