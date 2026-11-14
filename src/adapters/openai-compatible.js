/**
 * OpenAI-Compatible Adapter (OpenAI, DeepSeek, LiteLLM Proxy, Local vLLM)
 */
import { BaseAgentAdapter } from './base.js';
import { runBuiltinToolLoop } from '../core/builtin-tools.js';

export class OpenAICompatibleAdapter extends BaseAgentAdapter {
  constructor({ optimizer, provider = 'openai' } = {}) {
    super({ name: `openai-compatible:${provider}`, optimizer });
    this.provider = provider;
  }

  async transformRequest(payload = {}, meta = {}) {
    const messages = Array.isArray(payload.messages) ? payload.messages : [];
    const systemMsg = messages.find((m) => m.role === 'system');
    const nonSystem = messages.filter((m) => m.role !== 'system');

    const prepared = await this.beforeRequest({
      agentId: meta.agentId || 'openai-agent',
      sessionId: meta.sessionId || 'default',
      conversationKey: meta.conversationKey || meta.sessionId || 'default',
      scope: meta.scope,
      tenantId: meta.tenantId,
      isAdmin: meta.isAdmin,
      isOwner: meta.isOwner,
      includeSensitive: meta.includeSensitive,
      provider: meta.provider || this.provider,
      model: payload.model || meta.model || 'gpt-4o-mini',
      scene: meta.scene || 'default',
      toolFormat: 'openai',
      autoBuiltinTools: meta.autoBuiltinTools,
      autoExtractMemory: meta.autoExtractMemory,
      autoRecallMemory: meta.autoRecallMemory,
      recallQuery: meta.recallQuery,
      staticText: meta.staticText || (typeof systemMsg?.content === 'string' ? systemMsg.content : ''),
      messages: nonSystem,
      tools: payload.tools || [],
      currentInputTokens: meta.currentInputTokens,
      onBeforeRotate: meta.onBeforeRotate,
    });

    const outMessages = [];
    // Keep system message stable at index 0 unless explicitly omitted into dynamic turn
    if (systemMsg) {
      outMessages.push(systemMsg);
    } else if (prepared.staticText) {
      outMessages.push({ role: 'system', content: prepared.staticText });
    }
    if (prepared.handoffText) {
      outMessages.push({ role: 'system', content: prepared.handoffText });
    }
    if (prepared.recalledMemories?.found && prepared.recalledMemories.text) {
      outMessages.push({ role: 'system', content: `[Recalled Memories]\n${prepared.recalledMemories.text}` });
    }
    outMessages.push(...prepared.messages);

    const outPayload = {
      ...payload,
      messages: outMessages,
      ...(prepared.tools.length > 0 ? { tools: prepared.tools } : {}),
    };
    if (prepared.tools.length === 0 && payload.tools) {
      delete outPayload.tools;
    }

    return { payload: outPayload, prepared };
  }

  /**
   * Transform request, invoke upstream, and automatically execute UAO built-in retrieval/recall tool loops.
   */
  async runWithTools(payload = {}, invokeUpstreamFn, meta = {}) {
    if (typeof invokeUpstreamFn !== 'function') {
      throw new TypeError('OpenAICompatibleAdapter.runWithTools: invokeUpstreamFn is required');
    }
    const { payload: initialPayload, prepared } = await this.transformRequest(payload, meta);
    const loopRes = await runBuiltinToolLoop({
      optimizer: this.optimizer,
      initialPayload,
      meta: {
        ...meta,
        sessionId: prepared.sessionId,
        conversationKey: prepared.conversationKey,
        scope: meta.scope || prepared.conversationKey,
      },
      maxRounds: meta.maxToolRounds ?? 4,
      invokeUpstream: async (p, round) => await invokeUpstreamFn(p, prepared, round),
      onResponse: async (res, _p, round) => {
        await this.recordResponse(meta, res || {}, round === 0 ? prepared : null);
      },
    });
    return { ...loopRes, prepared };
  }

  async recordResponse(meta = {}, response = {}, prepared = null) {
    return await this.afterResponse(
      {
        agentId: meta.agentId || 'openai-agent',
        sessionId: meta.sessionId || prepared?.sessionId,
        conversationKey: meta.conversationKey || meta.sessionId,
        provider: meta.provider || this.provider,
        model: response.model || meta.model || 'gpt-4o-mini',
        messages: prepared?.messages,
      },
      {
        usage: response.usage || {},
        observed: Boolean(response.usage),
        baselineUsage: meta.baselineUsage,
      },
      prepared
    );
  }
}
