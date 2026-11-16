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
    const systemMsgs = messages.filter((m) => m.role === 'system');
    const firstSystemMsg = systemMsgs[0] || null;
    const extraSystemMsgs = systemMsgs.slice(1);
    const nonSystem = messages.filter((m) => m.role !== 'system');

    const prepared = await this.beforeRequest({
      agentId: meta.agentId || 'openai-agent',
      sessionId: meta.sessionId || 'default',
      conversationKey: meta.conversationKey || meta.sessionId || 'default',
      provider: meta.provider || this.provider,
      model: payload.model || meta.model || 'gpt-4o-mini',
      scene: meta.scene || 'default',
      staticText: meta.staticText || (typeof firstSystemMsg?.content === 'string' ? firstSystemMsg.content : ''),
      messages: nonSystem,
      tools: payload.tools || [],
      currentInputTokens: meta.currentInputTokens,
      onBeforeRotate: meta.onBeforeRotate,
    });

    const outMessages = [];
    // Keep system message(s) stable at the prefix
    if (firstSystemMsg) {
      outMessages.push(firstSystemMsg, ...extraSystemMsgs);
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
