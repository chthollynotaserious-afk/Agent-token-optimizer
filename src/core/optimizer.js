/**
 * UniversalAgentOptimizer Orchestrator
 *
 * Coordinates:
 *   - Invocation Controller (Opt-4)
 *   - Session Lifecycle Controller (Opt-1)
 *   - Tool Schema Governance (Opt-2)
 *   - Static Context Dedup (Opt-3)
 *   - Tool Result Retention & Single-Compressor Guard
 *   - Optional StateProvider
 *   - Token Ledger, Cost Tracker, Cache Tracker & Audit Log
 */

import { DEFAULT_PRICE_TABLE } from './model-prices.js';
import { estimateTokens } from './cache-economics.js';
import { SessionLifecycleController } from './session-lifecycle.js';
import { InvocationController } from './invocation-controller.js';
import { ToolGovernance } from './tool-governance.js';
import { evaluateUniversalDedup, commitUniversalDedupState } from './static-context-dedup.js';
import { ToolResultRetentionStore } from './tool-output-retention.js';
import { NoopStateProvider } from '../plugins/state-provider.js';
import { SingleCompressorCoordinator } from '../plugins/compression.js';
import { UniversalTokenLedger } from '../observability/token-ledger.js';
import { CostTracker } from '../observability/cost-tracker.js';
import { CacheTracker } from '../observability/cache-tracker.js';
import { AuditLog } from '../observability/audit-log.js';

export class UniversalAgentOptimizer {
  constructor(config = {}) {
    this.config = config;
    this.priceTable = config.priceTable || DEFAULT_PRICE_TABLE;
    this.auditLog = config.auditLog || new AuditLog({ file: config.auditFile || null });
    this.stateProvider = config.stateProvider || new NoopStateProvider();
    this.retentionStore = config.retentionStore || new ToolResultRetentionStore(config.retention || {});
    this.compressor = config.compressor || new SingleCompressorCoordinator({
      plugins: config.compressionPlugins || [],
      minQualityScore: config.minQualityScore ?? 72,
      retentionStore: this.retentionStore,
      auditLog: this.auditLog,
    });
    this.invocation = config.invocation || new InvocationController({
      config: config.invocationConfig || {},
      stateProvider: this.stateProvider,
      auditLog: this.auditLog,
    });
    this.lifecycle = config.lifecycle || new SessionLifecycleController({
      limits: config.lifecycleLimits || {},
      stateProvider: this.stateProvider,
      auditLog: this.auditLog,
    });
    this.toolGovernance = config.toolGovernance || new ToolGovernance({
      ...(config.toolGovernanceConfig || {}),
      auditLog: this.auditLog,
    });
    this.ledger = config.ledger || new UniversalTokenLedger({
      file: config.ledgerFile || null,
      priceTable: this.priceTable,
    });
    this.costTracker = config.costTracker || new CostTracker({ priceTable: this.priceTable });
    this.cacheTracker = config.cacheTracker || new CacheTracker();

    // Runtime per-conversation state
    this.globalState = { sessions: {}, sessionHistory: {} };
    this.conversationStates = new Map();
  }

  _getConversationState(key, initialSessionId = null) {
    let st = this.conversationStates.get(key);
    if (!st) {
      st = {
        sessionTurns: 0,
        lastActionAt: 0,
        staticContextState: null,
        pendingHandoff: null,
        recentMessages: [],
        lastInputTokens: 0,
      };
      this.conversationStates.set(key, st);
    }
    if (!this.globalState.sessions[key] && initialSessionId) {
      this.globalState.sessions[key] = initialSessionId;
    }
    return st;
  }

  async beforeWake(triggerEvent) {
    return await this.invocation.evaluateWake(triggerEvent);
  }

  async prepareRequest(ctx = {}) {
    const key = String(ctx.conversationKey || ctx.sessionId || 'default');
    const st = this._getConversationState(key, ctx.sessionId || `sess_${key}`);
    const now = Number(ctx.now) || Date.now();

    // 1. Check transactional session rotation (Opt-1)
    const rotation = await this.lifecycle.rotateIfNeeded(key, st, this.globalState, {
      currentInputTokens: ctx.currentInputTokens ?? st.lastInputTokens,
      now,
      onBeforeRotate: ctx.onBeforeRotate,
      verifyPersistence: ctx.verifyPersistence,
      verifyRecovery: ctx.verifyRecovery,
      agentName: ctx.agentId || 'Assistant',
    });

    const activeSessionId = this.globalState.sessions[key] || ctx.sessionId || `sess_${key}`;
    this.globalState.sessions[key] = activeSessionId;

    const handoffText = this.lifecycle.consumePendingHandoff(st);

    // 2. Govern Tool Schemas (Opt-2)
    const toolDecision = this.toolGovernance.govern({
      sessionId: activeSessionId,
      scene: ctx.scene || 'default',
      tools: ctx.tools || [],
      allowedTools: ctx.allowedTools,
      deniedTools: ctx.deniedTools,
    });

    // 3. Static Context Dedup (Opt-3)
    const staticText = ctx.staticText || '';
    const dedup = evaluateUniversalDedup({
      sessionId: activeSessionId,
      staticText,
      subBlocks: ctx.subBlocks || {},
      items: ctx.contextItems || [],
      prevState: st.staticContextState,
      forceFull: ctx.forceFullStatic === true,
      config: ctx.dedupConfig,
    });

    // 4. Optional StateProvider hints
    const stateSignals = await this.stateProvider.getContextSignals({ conversationKey: key, now });

    // 5. Retain / compress oversized tool messages safely
    const messages = [];
    for (const msg of (ctx.messages || [])) {
      if (msg.role === 'tool' && typeof msg.content === 'string' && msg.content.length > this.retentionStore.maxInlineChars) {
        const comp = await this.compressor.compressOnce(msg.content, {
          contentType: 'tool_output',
          model: ctx.model || 'deepseek-chat',
          alreadyCompressedBy: msg._compressedBy || null,
        });
        messages.push({ ...msg, content: comp.content, _compressedBy: comp.compressedBy || null });
      } else {
        messages.push(msg);
      }
    }

    // 6. Inspect prefix stability
    const cacheCheck = this.cacheTracker.inspectRequest({
      sessionId: activeSessionId,
      messages,
      tools: toolDecision.tools,
    });

    return {
      sessionId: activeSessionId,
      conversationKey: key,
      rotated: rotation.rotated,
      rolledBack: rotation.rolledBack,
      handoffText,
      staticText: dedup.staticText,
      emittedSubBlocks: dedup.emittedSubBlocks,
      emittedItems: dedup.emittedItems,
      stateSignals,
      messages,
      tools: toolDecision.tools,
      toolGovernance: toolDecision,
      cacheCheck,
      _pendingDedupCommit: dedup.pendingCommit,
      estimatedInputTokens: estimateTokens(messages) + estimateTokens(toolDecision.tools),
    };
  }

  async manageToolResult(toolCall, rawResult, opts = {}) {
    const raw = typeof rawResult === 'string' ? rawResult : JSON.stringify(rawResult ?? '', null, 2);
    return await this.compressor.compressOnce(raw, {
      contentType: opts.contentType || 'tool_output',
      model: opts.model || 'deepseek-chat',
      alreadyCompressedBy: opts.alreadyCompressedBy || null,
    });
  }

  retrieveToolResult(refId, opts = {}) {
    return this.retentionStore.retrieve(refId, opts);
  }

  async afterResponse(ctx = {}, response = {}, prepared = null) {
    const key = String(ctx.conversationKey || ctx.sessionId || 'default');
    const st = this._getConversationState(key, ctx.sessionId);
    const now = Number(ctx.now) || Date.now();

    st.sessionTurns += 1;
    st.lastActionAt = now;
    if (Array.isArray(ctx.messages)) {
      st.recentMessages = ctx.messages.slice(-10);
    }

    if (prepared?._pendingDedupCommit) {
      st.staticContextState = commitUniversalDedupState(
        st.staticContextState,
        prepared._pendingDedupCommit,
        now
      );
    }

    const entry = this.ledger.record({
      agentId: ctx.agentId || 'default',
      sessionId: prepared?.sessionId || this.globalState.sessions[key] || ctx.sessionId || 'default',
      conversationKey: key,
      provider: ctx.provider || 'deepseek',
      model: ctx.model || 'deepseek-chat',
      turn: st.sessionTurns,
      step: ctx.step || 1,
      usage: response.usage || {},
      observed: response.observed !== false,
      overheadCost: response.overheadCost || 0,
      ts: now,
    });

    st.lastInputTokens = entry.buckets.cacheMiss + entry.buckets.cacheHit + entry.buckets.cacheWrite;

    if (response.baselineUsage) {
      this.costTracker.trackStep({
        sessionId: entry.sessionId,
        model: entry.model,
        provider: entry.provider,
        baselineUsage: response.baselineUsage,
        optimizedUsage: entry.buckets,
        overheadCost: response.overheadCost || 0,
        observed: response.observed !== false,
        at: now,
      });
    }

    return entry;
  }

  getMetrics() {
    return {
      ledger: this.ledger.summary(),
      costComparison: this.costTracker.report(),
      cache: this.cacheTracker.stats(),
      auditCount: this.auditLog.entries.length,
    };
  }
}
