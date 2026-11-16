/**
 * UAO Layered Memory Architecture — RP / SillyTavern Adapter (Phase 4)
 *
 * Implements RP-specific scope isolation and versioned Narrative State Memory
 * as an adapter outside UAO Core:
 * - Preserves host character cards, system prompts, author notes, lorebooks,
 *   personas, and message order
 * - Never mutates or deletes host chat messages
 * - Isolates separate chats, duplicate character cards, group chats, and branches
 * - Supports safe no-memory / passthrough mode and provider-outage fallback
 */

import { MemoryInjectionPlanner } from '../memory/injection-budget.js';
import { MemoryRetriever } from '../memory/retriever.js';
import { deriveScopeKey, normalizeScope } from '../memory/scope.js';

export class RPMemoryAdapter {
  constructor({
    provider = null,
    retriever = null,
    injectionPlanner = null,
    auditLog = null,
    memoryEnabled = false, // Opt-in by default per release gate
  } = {}) {
    this.provider = provider;
    this.retriever = retriever || (provider ? new MemoryRetriever({ provider, auditLog }) : null);
    this.injectionPlanner = injectionPlanner || new MemoryInjectionPlanner();
    this.auditLog = auditLog;
    this.memoryEnabled = Boolean(memoryEnabled);
  }

  /**
   * Derive strict RP scope from host metadata.
   * Missing IDs never collapse unrelated chats into a shared default key.
   */
  deriveRpScope(hostCtx = {}) {
    const scope = normalizeScope({
      tenant_id: hostCtx.tenantId || hostCtx.tenant_id,
      runtime_instance_id: hostCtx.runtimeInstanceId || hostCtx.runtime_instance_id,
      user_id: hostCtx.userId || hostCtx.user_id,
      persona_id: hostCtx.personaId || hostCtx.persona_id,
      character_id: hostCtx.characterId || hostCtx.character_id,
      chat_id: hostCtx.chatId || hostCtx.chat_id,
      world_id: hostCtx.worldId || hostCtx.world_id,
      lorebook_id: hostCtx.lorebookId || hostCtx.lorebook_id,
      branch_id: hostCtx.branchId || hostCtx.branch_id,
      timeline_id: hostCtx.timelineId || hostCtx.timeline_id,
    });
    return scope;
  }

  /**
   * Record or update a versioned Narrative State view backed by source_refs.
   */
  async upsertNarrativeState(hostCtx = {}, narrativeState = {}, { sourceRefs = [], reason = 'narrative_update' } = {}) {
    if (!this.provider) {
      throw new Error('RPMemoryAdapter: provider is required to persist narrative state');
    }
    const scope = this.deriveRpScope(hostCtx);
    if (!scope || !scope.chat_id) {
      throw new TypeError('RPMemoryAdapter: chat_id is required in hostCtx for narrative state isolation');
    }
    const scopeKey = deriveScopeKey(scope);
    const stateId = `narrative_${scopeKey.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64)}`;

    const payload = {
      location: narrativeState.location ?? null,
      world_time: narrativeState.world_time ?? null,
      participants: Array.isArray(narrativeState.participants) ? narrativeState.participants : [],
      relationships: narrativeState.relationships || {},
      participant_knowledge: narrativeState.participant_knowledge || {},
      established_events: Array.isArray(narrativeState.established_events) ? narrativeState.established_events : [],
      open_threads: Array.isArray(narrativeState.open_threads) ? narrativeState.open_threads : [],
      promises: Array.isArray(narrativeState.promises) ? narrativeState.promises : [],
      branch_continuity: narrativeState.branch_continuity ?? scope.branch_id ?? null,
    };

    const existing = await this.provider.readRecord(stateId, scope);
    if (!existing) {
      return await this.provider.writeRecord({
        id: stateId,
        kind: 'narrative_state',
        scope,
        content: payload,
        epistemic_status: 'observed',
        source_refs: sourceRefs.length > 0 ? sourceRefs : [`chat:${scope.chat_id}`],
      });
    }

    return await this.provider.updateDerivedRecord(
      stateId,
      {
        content: payload,
        source_refs: sourceRefs,
        reason,
      },
      existing.version,
      scope
    );
  }

  /**
   * Prepare an RP turn without mutating host character cards, prompts, or messages.
   * Falls back cleanly to passthrough if memory is disabled or provider fails.
   */
  async prepareTurn({
    hostCtx = {},
    messages = [],
    queryText = '',
    memoryEnabled = this.memoryEnabled,
    maxMemoryTokens = 600,
  } = {}) {
    const scope = this.deriveRpScope(hostCtx);
    const passthroughResult = (fallbackReason = null) => ({
      mode: 'passthrough',
      memoryEnabled: false,
      fallbackReason,
      scope,
      messages: [...messages],
      memoryBlock: '',
      injectedTokens: 0,
      retrievedCount: 0,
    });

    if (!memoryEnabled || !this.retriever || !scope) {
      return passthroughResult(!memoryEnabled ? 'disabled' : 'missing_scope_or_provider');
    }

    try {
      const ret = await this.retriever.retrieve({
        queryText,
        scope,
        limit: 8,
        enabled: true,
      });
      const plan = this.injectionPlanner.planInjection({
        retrieved: ret.retrieved,
        enabled: true,
        maxMemoryTokens,
      });

      return {
        mode: 'orchestrated',
        memoryEnabled: true,
        fallbackReason: null,
        scope,
        // Original host messages are preserved untouched in original order
        messages: [...messages],
        memoryBlock: plan.promptBlock,
        injectedTokens: plan.injectedTokens,
        retrievedCount: ret.retrieved.length,
        overhead: plan.overhead,
      };
    } catch (err) {
      if (this.auditLog && typeof this.auditLog.log === 'function') {
        this.auditLog.log('memory', 'rp_provider_fallback', {
          error: err.message,
        });
      }
      return passthroughResult('provider_error');
    }
  }
}
