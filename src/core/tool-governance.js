/**
 * Contextual Tool Governance (Opt-2 evolved)
 *
 * Prevents tool schema bloat and mid-session KV cache invalidation:
 *   - Filters dead/disabled/unauthorized tools by scene or role
 *   - Sorts tool definitions deterministically to preserve prefix byte stability
 *   - Tracks schema hash across turns to detect accidental cache-busting jitter
 */

import crypto from 'node:crypto';
import { estimateTokens } from './cache-economics.js';

function toolNameOf(tool) {
  return String(tool?.function?.name || tool?.name || '').trim();
}

export function computeSchemaHash(tools = []) {
  const normalized = (Array.isArray(tools) ? tools : [])
    .slice()
    .sort((a, b) => toolNameOf(a).localeCompare(toolNameOf(b)));
  return crypto.createHash('sha256').update(JSON.stringify(normalized)).digest('hex').slice(0, 16);
}

export class ToolGovernance {
  constructor({
    deadTools = [],
    scenePolicies = {},
    defaultAllowAll = true,
    auditLog = null,
  } = {}) {
    this.deadTools = new Set(deadTools);
    this.scenePolicies = scenePolicies;
    this.defaultAllowAll = defaultAllowAll;
    this.auditLog = auditLog;
    this.lastSchemaBySession = new Map();
  }

  /**
   * Filter and stabilize tool schemas for a given scene/role/session.
   */
  govern({ sessionId = 'default', scene = 'default', tools = [], allowedTools = null, deniedTools = null } = {}) {
    const list = Array.isArray(tools) ? tools : [];
    const policy = this.scenePolicies[scene] || {};
    const allowSet = allowedTools
      ? new Set(allowedTools)
      : (Array.isArray(policy.allow) ? new Set(policy.allow) : null);
    const denySet = new Set([
      ...this.deadTools,
      ...(Array.isArray(policy.deny) ? policy.deny : []),
      ...(Array.isArray(deniedTools) ? deniedTools : []),
    ]);

    const kept = [];
    const removed = [];
    for (const tool of list) {
      const name = toolNameOf(tool);
      if (!name) continue;
      if (denySet.has(name)) {
        removed.push({ name, reason: this.deadTools.has(name) ? 'dead_tool' : 'denied' });
        continue;
      }
      if (allowSet && !allowSet.has(name)) {
        removed.push({ name, reason: 'not_in_scene_allowlist' });
        continue;
      }
      if (!allowSet && !this.defaultAllowAll && !policy.allow) {
        removed.push({ name, reason: 'fail_closed_no_policy' });
        continue;
      }
      kept.push(tool);
    }

    // Deterministic order protects KV cache prefix byte alignment
    kept.sort((a, b) => toolNameOf(a).localeCompare(toolNameOf(b)));

    const schemaHash = computeSchemaHash(kept);
    const prevHash = this.lastSchemaBySession.get(sessionId);
    const schemaJitter = Boolean(prevHash && prevHash !== schemaHash);
    this.lastSchemaBySession.set(sessionId, schemaHash);

    if (schemaJitter) {
      this.auditLog?.log('tool_governance', 'schema_jitter_detected', {
        sessionId,
        scene,
        prevHash,
        nextHash: schemaHash,
      });
    }

    const originalTokens = estimateTokens(list);
    const governedTokens = estimateTokens(kept);

    return {
      tools: kept,
      removed,
      schemaHash,
      schemaJitter,
      originalCount: list.length,
      keptCount: kept.length,
      savedTokensEstimate: Math.max(0, originalTokens - governedTokens),
    };
  }
}
