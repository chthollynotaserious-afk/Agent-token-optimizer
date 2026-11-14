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
import { UniversalMemoryStore, extractTextContent } from './memory-store.js';
import {
  BUILTIN_TOOL_NAMES,
  getBuiltinToolSpecs,
  formatBuiltinTools,
  mergeToolsWithoutDuplicates,
  executeBuiltinToolCall as dispatchBuiltinToolCall,
  runBuiltinToolLoop,
} from './builtin-tools.js';
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
    this.memoryStore = config.memoryStore || new UniversalMemoryStore({
      file: config.memoryFile || null,
      summarizeFn: config.memoryExtractor || null,
      ...(config.memoryConfig || {}),
    });
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
        sessionMessages: [],
        lastInputTokens: 0,
      };
      this.conversationStates.set(key, st);
    }
    if (!this.globalState.sessions[key] && initialSessionId) {
      this.globalState.sessions[key] = initialSessionId;
    }
    return st;
  }

  _recordSessionMessages(st, messages = [], ts = Date.now()) {
    if (!Array.isArray(messages) || messages.length === 0) return;
    if (!Array.isArray(st.sessionMessages)) st.sessionMessages = [];

    const normalized = messages
      .filter((m) => m && typeof m === 'object' && m.role !== 'system')
      .map((m) => ({
        role: m.role || 'user',
        content: extractTextContent(m.content ?? m.rawMessage ?? m.text ?? ''),
        ts: Number(m.ts) || ts,
      }))
      .filter((m) => m.content);

    if (normalized.length === 0) return;

    // Detect cumulative history array vs delta per-turn array
    const firstExisting = st.sessionMessages[0];
    const firstIncoming = normalized[0];
    const isCumulative = Boolean(
      firstExisting
      && firstIncoming
      && firstExisting.role === firstIncoming.role
      && firstExisting.content === firstIncoming.content
    );

    if (isCumulative) {
      for (let i = st.sessionMessages.length; i < normalized.length; i += 1) {
        st.sessionMessages.push(normalized[i]);
      }
    } else {
      for (const item of normalized) {
        const last = st.sessionMessages[st.sessionMessages.length - 1];
        if (!last || last.role !== item.role || last.content !== item.content) {
          st.sessionMessages.push(item);
        }
      }
    }

    if (st.sessionMessages.length > 200) {
      st.sessionMessages = st.sessionMessages.slice(-200);
    }
  }

  async beforeWake(triggerEvent) {
    return await this.invocation.evaluateWake(triggerEvent);
  }

  getBuiltinTools({
    format = 'openai',
    includeRetrieve = true,
    includeRecall = true,
  } = {}) {
    return formatBuiltinTools(getBuiltinToolSpecs({ includeRetrieve, includeRecall }), format);
  }

  executeBuiltinToolCall(call, trustedCtx = {}) {
    return dispatchBuiltinToolCall(this, call, trustedCtx);
  }

  async extractAndSaveMemory({
    conversationKey = 'default',
    sessionId = null,
    scope = null,
    tenantId = null,
    audience = 'private',
    messages = null,
    reason = 'manual_flush',
    now = Date.now(),
  } = {}) {
    const key = String(conversationKey || sessionId || 'default');
    const st = this._getConversationState(key, sessionId || `sess_${key}`);
    const activeSessionId = sessionId || this.globalState.sessions[key] || `sess_${key}`;
    const sourceMessages = Array.isArray(messages) && messages.length > 0
      ? messages
      : (st.sessionMessages.length > 0 ? st.sessionMessages : st.recentMessages);
    return await this.memoryStore.flushSession({
      sessionId: activeSessionId,
      conversationKey: key,
      scope: scope || key,
      tenantId,
      audience,
      messages: sourceMessages,
      reason,
      now,
    });
  }

  recallMemory(opts = {}) {
    return this.memoryStore.recall(opts);
  }

  async prepareRequest(ctx = {}) {
    const key = String(ctx.conversationKey || ctx.sessionId || 'default');
    const st = this._getConversationState(key, ctx.sessionId || `sess_${key}`);
    const now = Number(ctx.now) || Date.now();

    const hasCustomRotateHook = typeof ctx.onBeforeRotate === 'function';
    const shouldAutoFlush = ctx.autoExtractMemory !== false
      && (!hasCustomRotateHook || ctx.alsoExtractBuiltinMemory === true);

    const onBeforeRotate = async (rotateCtx) => {
      let hostRes = { flushed: true };
      if (hasCustomRotateHook) {
        const res = await ctx.onBeforeRotate(rotateCtx);
        if (res && typeof res === 'object') hostRes = res;
      } else if (this.stateProvider?.onBeforeSessionRotate && this.stateProvider.name !== 'noop') {
        hostRes = await this.stateProvider.onBeforeSessionRotate({
          conversationKey: rotateCtx.key,
          fromSessionId: rotateCtx.fromSessionId,
          recentMessages: rotateCtx.recentMessages,
        });
      }
      if (hostRes?.flushed === false) return hostRes;
      if (shouldAutoFlush) {
        const sourceMessages = rotateCtx.st.sessionMessages?.length > 0
          ? rotateCtx.st.sessionMessages
          : rotateCtx.recentMessages;
        const memRes = await this.memoryStore.flushSession({
          sessionId: rotateCtx.fromSessionId,
          conversationKey: rotateCtx.key,
          scope: ctx.scope || rotateCtx.key,
          tenantId: ctx.tenantId || null,
          audience: ctx.audience || 'private',
          messages: sourceMessages,
          reason: rotateCtx.reason,
          now: rotateCtx.now,
        });
        return {
          ...hostRes,
          ...memRes,
          flushed: hostRes.flushed !== false && memRes.flushed !== false,
        };
      }
      return hostRes;
    };

    const verifyPersistence = typeof ctx.verifyPersistence === 'function'
      ? ctx.verifyPersistence
      : (shouldAutoFlush
          ? ({ flushResult }) => !flushResult?.verificationToken || this.memoryStore.hasVerificationToken(flushResult.verificationToken)
          : undefined);

    // 1. Check transactional session rotation (Opt-1) with built-in memory flush
    const rotation = await this.lifecycle.rotateIfNeeded(key, st, this.globalState, {
      currentInputTokens: ctx.currentInputTokens ?? st.lastInputTokens,
      now,
      onBeforeRotate,
      verifyPersistence,
      verifyRecovery: ctx.verifyRecovery,
      agentName: ctx.agentId || 'Assistant',
    });

    if (rotation.rotated) {
      st.sessionMessages = [];
    }

    const activeSessionId = this.globalState.sessions[key] || ctx.sessionId || `sess_${key}`;
    this.globalState.sessions[key] = activeSessionId;

    const handoffText = this.lifecycle.consumePendingHandoff(st);

    // Track current session messages for future extraction
    this._recordSessionMessages(st, ctx.messages || [], now);

    // 2. Retain / compress oversized tool messages safely BEFORE tool schema wiring
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

    // 3. Auto-wire built-in retrieval & memory-recall tool schemas when eligible, then govern (Opt-2)
    const scene = ctx.scene || 'default';
    const builtinMode = ctx.autoBuiltinTools ?? this.config.autoBuiltinTools ?? 'auto';
    const scenePolicy = this.toolGovernance.scenePolicies[scene] || {};
    const hasStrictAllowlist = Boolean(ctx.allowedTools || Array.isArray(scenePolicy.allow));
    const forceBuiltin = builtinMode === true || builtinMode === 'always';

    let candidateTools = Array.isArray(ctx.tools) ? [...ctx.tools] : [];
    let effectiveAllowedTools = ctx.allowedTools;

    if (builtinMode !== false && builtinMode !== 'off' && (forceBuiltin || !hasStrictAllowlist)) {
      const includeRetrieve = forceBuiltin || this.retentionStore.entries.size > 0;
      const includeRecall = forceBuiltin || this.memoryStore.size > 0;
      if (includeRetrieve || includeRecall) {
        const inferredFormat = ctx.toolFormat
          || (candidateTools.some((t) => t && Object.hasOwn(t, 'input_schema')) ? 'anthropic' : 'openai');
        const builtinTools = this.getBuiltinTools({
          format: inferredFormat,
          includeRetrieve,
          includeRecall,
        });
        candidateTools = mergeToolsWithoutDuplicates(candidateTools, builtinTools);
        if (forceBuiltin && hasStrictAllowlist) {
          const baseAllow = Array.isArray(ctx.allowedTools) ? ctx.allowedTools : scenePolicy.allow;
          effectiveAllowedTools = [
            ...baseAllow,
            ...(includeRetrieve ? [BUILTIN_TOOL_NAMES.RETRIEVE_TOOL_OUTPUT] : []),
            ...(includeRecall ? [BUILTIN_TOOL_NAMES.RECALL_MEMORY] : []),
          ];
        }
      }
    }

    const toolDecision = this.toolGovernance.govern({
      sessionId: activeSessionId,
      scene,
      tools: candidateTools,
      allowedTools: effectiveAllowedTools,
      deniedTools: ctx.deniedTools,
    });

    // 4. Static Context Dedup (Opt-3)
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

    // 5. Optional StateProvider hints & on-demand memory recall
    const stateSignals = await this.stateProvider.getContextSignals({ conversationKey: key, now });
    let recalledMemories = null;
    if ((ctx.autoRecallMemory === true || this.config.autoRecallMemory === true) && this.memoryStore.size > 0) {
      const lastUser = [...messages].reverse().find((m) => m?.role === 'user');
      const query = ctx.recallQuery || extractTextContent(lastUser?.content || '');
      recalledMemories = this.memoryStore.recall({
        query,
        conversationKey: key,
        scope: ctx.scope || key,
        tenantId: ctx.tenantId || null,
        isAdmin: ctx.isAdmin === true,
        isOwner: ctx.isOwner === true,
        includeSensitive: ctx.includeSensitive === true,
        limit: ctx.recallLimit ?? 5,
        now,
      });
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
      recalledMemories,
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
      this._recordSessionMessages(st, ctx.messages, now);
    }
    const assistantText = extractTextContent(response?.choices?.[0]?.message?.content ?? response?.content ?? '');
    if (assistantText) {
      this._recordSessionMessages(st, [{ role: 'assistant', content: assistantText, ts: now }], now);
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

  /**
   * High-level wrapper combining prepareRequest -> invokeUpstream (+ automatic built-in retrieval/recall tool loop) -> afterResponse.
   */
  async optimizeRequest({ invokeUpstream, handleBuiltinTools = true, maxToolRounds = 4, ...ctx } = {}) {
    if (typeof invokeUpstream !== 'function') {
      throw new TypeError('optimizeRequest: invokeUpstream callback is required');
    }
    const prepared = await this.prepareRequest(ctx);
    let lastEntry = null;

    if (handleBuiltinTools === false) {
      const response = await invokeUpstream({
        ...ctx,
        sessionId: prepared.sessionId,
        conversationKey: prepared.conversationKey,
        messages: prepared.messages,
        tools: prepared.tools,
        staticText: prepared.staticText,
        handoffText: prepared.handoffText,
        prepared,
      });
      lastEntry = await this.afterResponse(ctx, response || {}, prepared);
      return {
        response,
        prepared,
        entry: lastEntry,
        builtinToolRounds: 0,
        executedBuiltinTools: [],
        telemetry: {
          ...lastEntry,
          cacheCheck: prepared.cacheCheck,
          rotated: prepared.rotated,
          rolledBack: prepared.rolledBack,
        },
      };
    }

    const loopRes = await runBuiltinToolLoop({
      optimizer: this,
      initialPayload: {
        messages: prepared.messages,
        tools: prepared.tools,
      },
      meta: {
        ...ctx,
        sessionId: prepared.sessionId,
        conversationKey: prepared.conversationKey,
        scope: ctx.scope || prepared.conversationKey,
      },
      maxRounds: maxToolRounds,
      invokeUpstream: async (payload, round) => await invokeUpstream({
        ...ctx,
        sessionId: prepared.sessionId,
        conversationKey: prepared.conversationKey,
        messages: payload.messages,
        tools: payload.tools,
        staticText: prepared.staticText,
        handoffText: prepared.handoffText,
        prepared,
        round,
      }),
      onResponse: async (res, payload, round) => {
        lastEntry = await this.afterResponse(
          { ...ctx, messages: payload.messages, step: round + 1 },
          res || {},
          round === 0 ? prepared : null
        );
      },
    });

    return {
      response: loopRes.response,
      prepared,
      entry: lastEntry,
      builtinToolRounds: loopRes.rounds,
      executedBuiltinTools: loopRes.executedCalls,
      telemetry: {
        ...lastEntry,
        cacheCheck: prepared.cacheCheck,
        rotated: prepared.rotated,
        rolledBack: prepared.rolledBack,
        builtinToolRounds: loopRes.rounds,
      },
    };
  }

  getMetrics() {
    return {
      ledger: this.ledger.summary(),
      costComparison: this.costTracker.report(),
      cache: this.cacheTracker.stats(),
      auditCount: this.auditLog.entries.length,
      memory: {
        records: this.memoryStore.records.length,
        archives: this.memoryStore.archives.length,
      },
    };
  }
}
