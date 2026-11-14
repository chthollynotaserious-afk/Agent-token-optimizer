/**
 * OpenAI-Compatible Adapter (OpenAI, DeepSeek, LiteLLM Proxy, Local vLLM)
 */
import { BaseAgentAdapter } from './base.js';

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
      provider: meta.provider || this.provider,
      model: payload.model || meta.model || 'gpt-4o-mini',
      scene: meta.scene || 'default',
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
