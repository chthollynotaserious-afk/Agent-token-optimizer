/**
 * Anthropic Messages API Adapter
 * Supports `system` blocks with explicit `cache_control` breakpoint preservation.
 */
import { BaseAgentAdapter } from './base.js';

export class AnthropicAdapter extends BaseAgentAdapter {
  constructor({ optimizer } = {}) {
    super({ name: 'anthropic', optimizer });
  }

  async transformRequest(payload = {}, meta = {}) {
    const sysText = Array.isArray(payload.system)
      ? payload.system.map((b) => b?.text || '').join('\n')
      : String(payload.system || '');

    const prepared = await this.beforeRequest({
      agentId: meta.agentId || 'anthropic-agent',
      sessionId: meta.sessionId || 'default',
      conversationKey: meta.conversationKey || meta.sessionId || 'default',
      provider: 'anthropic',
      model: payload.model || meta.model || 'claude-sonnet-4',
      scene: meta.scene || 'default',
      staticText: meta.staticText || sysText,
      messages: Array.isArray(payload.messages) ? payload.messages : [],
      tools: payload.tools || [],
      currentInputTokens: meta.currentInputTokens,
    });

    // Preserve Anthropic explicit cache_control breakpoint on static system block
    const systemBlocks = [];
    if (Array.isArray(payload.system) && payload.system.length > 0) {
      systemBlocks.push(...payload.system);
    } else if (sysText) {
      systemBlocks.push({ type: 'text', text: sysText, cache_control: { type: 'ephemeral' } });
    }
    if (prepared.handoffText) {
      systemBlocks.push({ type: 'text', text: prepared.handoffText });
    }

    const outPayload = {
      ...payload,
      ...(systemBlocks.length > 0 ? { system: systemBlocks } : {}),
      messages: prepared.messages,
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
        agentId: meta.agentId || 'anthropic-agent',
        sessionId: meta.sessionId || prepared?.sessionId,
        conversationKey: meta.conversationKey || meta.sessionId,
        provider: 'anthropic',
        model: response.model || meta.model || 'claude-sonnet-4',
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
