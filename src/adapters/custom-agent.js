/**
 * Custom Agent, MCP, and LangGraph Adapters
 */
import { BaseAgentAdapter } from './base.js';

export class CustomAgentAdapter extends BaseAgentAdapter {
  constructor({ optimizer, agentId = 'custom-agent' } = {}) {
    super({ name: `custom:${agentId}`, optimizer });
    this.agentId = agentId;
  }

  async runTurn(ctx, invokeModelFn) {
    if (ctx.triggerEvent) {
      const wake = await this.onWakeCheck(ctx.triggerEvent);
      if (!wake.allow) {
        return { skipped: true, wakeDecision: wake, response: null };
      }
    }
    const prepared = await this.beforeRequest({ agentId: this.agentId, ...ctx });
    const response = await invokeModelFn(prepared);
    const ledgerEntry = await this.afterResponse({ agentId: this.agentId, ...ctx }, response, prepared);
    return { skipped: false, prepared, response, ledgerEntry };
  }
}

export class MCPToolAdapter extends BaseAgentAdapter {
  constructor({ optimizer } = {}) {
    super({ name: 'mcp', optimizer });
  }

  filterTools({ sessionId, scene = 'default', tools = [] }) {
    return this.optimizer.toolGovernance.govern({ sessionId, scene, tools });
  }

  async wrapToolCall(toolName, args, executeFn) {
    const raw = await executeFn(args);
    const managed = await this.onToolResult({ name: toolName, args }, raw, { contentType: 'tool_output' });
    return {
      content: managed.content,
      retainedRefId: managed.originalRefId || null,
      compressedBy: managed.compressedBy || null,
    };
  }
}

export class LangGraphAdapter extends BaseAgentAdapter {
  constructor({ optimizer, agentId = 'langgraph' } = {}) {
    super({ name: `langgraph:${agentId}`, optimizer });
    this.agentId = agentId;
  }

  async preModelNode(state = {}) {
    const threadId = state.threadId || state.sessionId || 'lg-default';
    const prepared = await this.beforeRequest({
      agentId: this.agentId,
      sessionId: threadId,
      conversationKey: state.conversationKey || threadId,
      provider: state.provider || 'openai',
      model: state.model || 'gpt-4o-mini',
      scene: state.scene || 'default',
      messages: state.messages || [],
      tools: state.tools || [],
      staticText: state.systemPrompt || '',
      currentInputTokens: state.lastInputTokens,
    });
    return { ...state, messages: prepared.messages, tools: prepared.tools, _uaoPrepared: prepared };
  }

  async postModelNode(state = {}, modelResult = {}) {
    const prepared = state._uaoPrepared || null;
    await this.afterResponse(
      {
        agentId: this.agentId,
        sessionId: state.threadId || state.sessionId,
        conversationKey: state.conversationKey || state.threadId,
        provider: state.provider || 'openai',
        model: modelResult.model || state.model || 'gpt-4o-mini',
        messages: state.messages,
      },
      { usage: modelResult.usage || {}, observed: Boolean(modelResult.usage) },
      prepared
    );
    return state;
  }
}
