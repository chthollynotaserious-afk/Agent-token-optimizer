/**
 * UAO Layered Memory Architecture — Memory Policy Engine (Phase 5)
 *
 * Coordinates opt-in memory policies (encode, retrieve, inject, consolidate,
 * forget/archive, delete) while keeping personality/Self-Memory outside UAO Core.
 */

import { MemoryConsolidator } from './consolidator.js';
import { MemoryInjectionPlanner } from './injection-budget.js';
import { MemoryRetriever } from './retriever.js';
import { normalizeScope } from './scope.js';

export class MemoryPolicyEngine {
  constructor({
    provider,
    associationIndex = null,
    ledger = null,
    auditLog = null,
    enabled = false, // Opt-in by default
    maxMemoryTokens = 800,
    minRelevanceScore = 0.2,
  } = {}) {
    if (!provider) {
      throw new TypeError('MemoryPolicyEngine: provider is required');
    }
    this.provider = provider;
    this.auditLog = auditLog;
    this.enabled = Boolean(enabled);
    this.retriever = new MemoryRetriever({ provider, auditLog, minRelevanceScore });
    this.injectionPlanner = new MemoryInjectionPlanner({ enabled: this.enabled, maxMemoryTokens });
    this.consolidator = new MemoryConsolidator({ provider, associationIndex, ledger, auditLog });
  }

  /**
   * Encoding Policy: skip empty/trivial/ephemeral messages rather than saving every message.
   */
  shouldEncode({ content = '', ephemeral = false, minChars = 12 } = {}) {
    if (!this.enabled || ephemeral) return { encode: false, reason: ephemeral ? 'ephemeral' : 'disabled' };
    const text = typeof content === 'string' ? content.trim() : JSON.stringify(content ?? '');
    if (text.length < minChars) return { encode: false, reason: 'too_short' };
    return { encode: true, reason: 'eligible' };
  }

  async encodeEpisodic({ content, scope, sourceRefs = [], epistemicStatus = 'observed', ephemeral = false } = {}) {
    const decision = this.shouldEncode({ content, ephemeral });
    if (!decision.encode) {
      return { stored: false, reason: decision.reason, record: null };
    }
    const record = await this.provider.writeRecord({
      kind: 'episodic',
      scope,
      content,
      source_refs: sourceRefs,
      epistemic_status: epistemicStatus,
    });
    return { stored: true, reason: 'encoded', record };
  }

  /**
   * Retrieval + Injection Policy (separated steps).
   */
  async prepareMemoryContext({ queryText = '', scope, maxMemoryTokens, enabled = this.enabled } = {}) {
    if (!enabled) {
      return this.injectionPlanner.planInjection({ retrieved: [], enabled: false });
    }
    const ret = await this.retriever.retrieve({ queryText, scope, enabled: true });
    return this.injectionPlanner.planInjection({
      retrieved: ret.retrieved,
      enabled: true,
      maxMemoryTokens,
    });
  }

  /**
   * Forgetting Policy: archive low-value derived records without deleting authoritative raw records.
   */
  async archiveDerivedRecord(id, scope, { reason = 'forgetting_policy_archive' } = {}) {
    const normScope = normalizeScope(scope);
    if (!normScope) throw new TypeError('MemoryPolicyEngine: valid scope is required');
    const existing = await this.provider.readRecord(id, normScope);
    if (!existing) return { archived: false, reason: 'not_found' };
    if (existing.kind === 'episodic') {
      return { archived: false, reason: 'episodic_immutable_use_explicit_delete' };
    }
    const updated = await this.provider.updateDerivedRecord(
      id,
      { status: 'archived', reason },
      existing.version,
      normScope
    );
    return { archived: true, record: updated };
  }
}
