/**
 * Optional StateProvider Interface (P1)
 *
 * Decouples the Universal Agent Optimizer core from any companion/persona/emotion state.
 * Default is NoopStateProvider (zero overhead, stateless).
 * CompanionStateProvider wraps legacy emotion-state & memory-reconsolidation as an optional plugin.
 */

import { emotionBias, emotionPromptLine } from '../emotion-state.js';

export class NoopStateProvider {
  constructor() {
    this.name = 'noop';
  }

  async getContextSignals() {
    return { promptHints: [], priorityBoostById: {}, invocationBias: 0 };
  }

  async onBeforeSessionRotate() {
    return { flushed: true };
  }

  async onRecordsSelected() {}
}

/**
 * Reference optional plugin for companion/long-term persona agents (e.g. Denia).
 * Generic agents (Coding, Tool-calling, Workflow) do NOT need this provider.
 */
export class CompanionStateProvider {
  constructor({
    emotionManager = null,
    reconsolidationStore = null,
    emotionConfig = {},
    onMemoryFlush = null,
  } = {}) {
    this.name = 'companion-state';
    this.emotionManager = emotionManager;
    this.reconsolidationStore = reconsolidationStore;
    this.emotionConfig = emotionConfig;
    this.onMemoryFlush = onMemoryFlush;
  }

  async getContextSignals({ now = Date.now() } = {}) {
    const state = this.emotionManager?.getDecayed?.(now) || null;
    if (!state) return { promptHints: [], priorityBoostById: {}, invocationBias: 0 };
    const line = emotionPromptLine(state, this.emotionConfig);
    const bias = emotionBias(state, this.emotionConfig);
    return {
      promptHints: line ? [line] : [],
      priorityBoostById: {},
      invocationBias: bias,
      emotionState: state,
    };
  }

  async onBeforeSessionRotate(handoffPayload) {
    if (typeof this.onMemoryFlush === 'function') {
      return await this.onMemoryFlush(handoffPayload);
    }
    return { flushed: true };
  }

  async onRecordsSelected(records = [], { now = Date.now() } = {}) {
    if (!this.reconsolidationStore || !Array.isArray(records) || records.length === 0) return;
    const state = this.emotionManager?.getDecayed?.(now) || null;
    this.reconsolidationStore.recordRecall(records, state);
  }
}
