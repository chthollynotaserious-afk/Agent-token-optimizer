/**
 * UAO Layered Memory Architecture — Optional, Metered & Recoverable Consolidator (Phase 3)
 *
 * - Never overwrites raw episodic records
 * - Preserves conflicting evidence and version history
 * - Optional model-assisted extractor is metered and retry-limited
 * - Failed consolidation leaves the last known-good state intact
 * - Supports background queue with backpressure off the critical path
 */

import { normalizeScope, deriveScopeKey } from './scope.js';

export class MemoryConsolidator {
  constructor({
    provider,
    associationIndex = null,
    ledger = null,
    auditLog = null,
    maxRetries = 2,
    maxQueueSize = 100,
  } = {}) {
    if (!provider) {
      throw new TypeError('MemoryConsolidator: provider is required');
    }
    this.provider = provider;
    this.associationIndex = associationIndex;
    this.ledger = ledger;
    this.auditLog = auditLog;
    this.maxRetries = maxRetries;
    this.maxQueueSize = maxQueueSize;
    this.queue = [];
    this.running = false;
  }

  /**
   * Enqueue a consolidation job off the live request critical path.
   */
  enqueueConsolidation(job = {}) {
    if (this.queue.length >= this.maxQueueSize) {
      return { queued: false, reason: 'queue_full', queueLength: this.queue.length };
    }
    const promise = new Promise((resolve, reject) => {
      this.queue.push({ job, resolve, reject });
    });
    this._drainQueue();
    return { queued: true, queueLength: this.queue.length, promise };
  }

  async _drainQueue() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length > 0) {
        const { job, resolve, reject } = this.queue.shift();
        try {
          const result = await this.consolidateScope(job);
          resolve(result);
        } catch (err) {
          reject(err);
        }
      }
    } finally {
      this.running = false;
    }
  }

  /**
   * Consolidate episodic records into derived semantic claims / summaries
   * within a single authorized scope.
   */
  async consolidateScope({
    scope,
    extractor = null,
    model = 'memory-rule-extractor',
    claimKey = 'default_summary',
  } = {}) {
    const normScope = normalizeScope(scope);
    if (!normScope) {
      throw new TypeError('MemoryConsolidator: valid non-empty scope is required');
    }
    const scopeKey = deriveScopeKey(normScope);

    const episodicRecords = await this.provider.queryRecords(
      { kind: 'episodic', status: 'active', limit: 200 },
      normScope
    );
    if (episodicRecords.length === 0) {
      return { ok: true, created: 0, updated: 0, disputed: 0, skipped: true };
    }

    // 1. Run optional extractor with retry limit (off-state, before any mutation)
    let extractedClaims = null;
    let lastError = null;
    if (typeof extractor === 'function') {
      for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
        try {
          const res = await extractor({ scope: normScope, episodicRecords, attempt });
          if (res?.usage && this.ledger && typeof this.ledger.record === 'function') {
            this.ledger.record({
              agentId: 'memory-consolidator',
              sessionId: scopeKey,
              model: res.model || model,
              usage: res.usage,
              observed: Boolean(res.observed),
            });
          }
          extractedClaims = Array.isArray(res?.claims) ? res.claims : [];
          lastError = null;
          break;
        } catch (err) {
          lastError = err;
        }
      }
      if (lastError) {
        if (this.auditLog && typeof this.auditLog.log === 'function') {
          this.auditLog.log('memory', 'consolidation_failed', {
            scopeKey,
            error: lastError.message,
          });
        }
        return {
          ok: false,
          error: lastError.message,
          preservedLastKnownGood: true,
          created: 0,
          updated: 0,
          disputed: 0,
        };
      }
    } else {
      // Zero-LLM deterministic rule-based summary candidate
      const sourceIds = episodicRecords.map((r) => r.id);
      const snippets = episodicRecords
        .slice(0, 5)
        .map((r) => (typeof r.content === 'string' ? r.content : JSON.stringify(r.content)));
      extractedClaims = [
        {
          key: claimKey,
          kind: 'summary',
          content: `Consolidated ${episodicRecords.length} episodic record(s): ${snippets.join(' | ')}`,
          epistemic_status: 'inferred',
          source_refs: sourceIds,
          confidence: 0.75,
        },
      ];
    }

    // 2. Apply derived updates without ever modifying raw episodic records
    let created = 0;
    let updated = 0;
    let disputed = 0;
    const existingDerived = await this.provider.queryRecords(
      { status: 'active', limit: 200 },
      normScope
    );

    for (const claim of extractedClaims) {
      const targetId = `derived_${scopeKey.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 48)}_${String(claim.key || claimKey)}`;
      const existing = existingDerived.find((r) => r.id === targetId && r.kind !== 'episodic');
      const sourceRefs = Array.isArray(claim.source_refs) && claim.source_refs.length > 0
        ? claim.source_refs
        : episodicRecords.map((r) => r.id);

      if (!existing) {
        const rec = await this.provider.writeRecord({
          id: targetId,
          kind: claim.kind || 'semantic',
          scope: normScope,
          content: claim.content,
          epistemic_status: claim.epistemic_status || 'inferred',
          confidence: claim.confidence ?? 0.75,
          source_refs: sourceRefs,
        });
        created += 1;
        if (this.associationIndex) {
          for (const refId of sourceRefs) {
            this.associationIndex.addEdge({
              fromId: rec.id,
              toId: refId,
              relation: 'derived_from',
              scope: normScope,
              confidence: rec.confidence,
            });
          }
        }
      } else if (existing.content !== claim.content) {
        const isConflict = Boolean(claim.conflict) || (
          existing.epistemic_status === 'observed' && claim.epistemic_status !== 'observed'
        );
        const nextStatus = isConflict ? 'disputed' : (claim.epistemic_status || existing.epistemic_status);
        const nextContent = isConflict
          ? `${existing.content} || [Conflicting evidence] ${claim.content}`
          : claim.content;

        await this.provider.updateDerivedRecord(
          existing.id,
          {
            content: nextContent,
            epistemic_status: nextStatus,
            source_refs: sourceRefs,
            reason: isConflict ? 'conflict_preserved' : 'consolidation_update',
          },
          existing.version,
          normScope
        );
        updated += 1;
        if (isConflict) disputed += 1;
      }
    }

    if (this.auditLog && typeof this.auditLog.log === 'function') {
      this.auditLog.log('memory', 'consolidation_complete', {
        scopeKey,
        created,
        updated,
        disputed,
      });
    }

    return { ok: true, created, updated, disputed };
  }
}
