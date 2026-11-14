/**
 * CacheTracker: tracks prefix stability, cache hit/miss ratios, and cache invalidation events.
 */
import { analyzePrefixStability } from '../core/cache-economics.js';

export class CacheTracker {
  constructor() {
    this.lastPayloadBySession = new Map();
    this.events = [];
  }

  inspectRequest({ sessionId, messages = [], tools = [] }) {
    const prev = this.lastPayloadBySession.get(sessionId);
    const stability = prev
      ? analyzePrefixStability({
          prevMessages: prev.messages,
          nextMessages: messages,
          prevTools: prev.tools,
          nextTools: tools,
        })
      : {
          prefixIntact: true,
          toolsChanged: false,
          divergedAtIndex: -1,
          preservedTokens: 0,
          invalidatedTokens: 0,
          reason: 'initial_request',
        };
    this.lastPayloadBySession.set(sessionId, {
      messages: structuredClone(messages),
      tools: structuredClone(tools),
    });
    this.events.push({ sessionId, ts: Date.now(), ...stability });
    return stability;
  }

  stats() {
    let checks = 0;
    let intact = 0;
    let breaks = 0;
    let invalidatedTokens = 0;
    for (const e of this.events) {
      checks += 1;
      if (e.prefixIntact) intact += 1;
      else {
        breaks += 1;
        invalidatedTokens += e.invalidatedTokens;
      }
    }
    return { checks, intact, breaks, invalidatedTokens };
  }
}
