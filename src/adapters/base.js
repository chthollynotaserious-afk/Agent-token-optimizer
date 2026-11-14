/**
 * Base AgentAdapter Contract
 */
export class BaseAgentAdapter {
  constructor({ name = 'base', optimizer }) {
    if (!optimizer) throw new Error(`${name}: optimizer instance is required`);
    this.name = name;
    this.optimizer = optimizer;
  }

  async onWakeCheck(triggerEvent) {
    return await this.optimizer.beforeWake(triggerEvent);
  }

  async beforeRequest(ctx) {
    return await this.optimizer.prepareRequest(ctx);
  }

  async onToolResult(toolCall, rawResult, opts = {}) {
    return await this.optimizer.manageToolResult(toolCall, rawResult, opts);
  }

  async afterResponse(ctx, response, prepared = null) {
    return await this.optimizer.afterResponse(ctx, response, prepared);
  }
}
