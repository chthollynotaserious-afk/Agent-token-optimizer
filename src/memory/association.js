/**
 * UAO Layered Memory Architecture — L4 Lightweight Associative Index (Phase 3)
 *
 * Associations are derived, rebuildable indexes — never primary evidence.
 * Cross-scope traversal is denied by default unless explicitly authorized.
 */

import crypto from 'node:crypto';
import { canAccessMemoryScope, normalizeScope } from './scope.js';

export class MemoryAssociationIndex {
  constructor() {
    this.edges = new Map();
  }

  addEdge({
    fromId,
    toId,
    relation = 'related_to',
    scope,
    provenance = {},
    confidence = 0.8,
  } = {}) {
    const normScope = normalizeScope(scope);
    if (!normScope) {
      throw new TypeError('AssociationEdge: valid non-empty scope is required');
    }
    if (!fromId || !toId) {
      throw new TypeError('AssociationEdge: fromId and toId are required');
    }

    const edge = {
      id: `edge_${crypto.randomUUID()}`,
      fromId: String(fromId),
      toId: String(toId),
      relation: String(relation),
      scope: normScope,
      provenance: {
        source_type: provenance.source_type || 'consolidation',
        source_id: provenance.source_id || String(fromId),
      },
      confidence: Math.min(1, Math.max(0, Number(confidence) || 0.5)),
      status: 'active',
      created_at: new Date().toISOString(),
    };
    this.edges.set(edge.id, edge);
    return structuredClone(edge);
  }

  queryNeighbors(nodeId, scope, opts = {}) {
    const normScope = normalizeScope(scope);
    if (!normScope || !nodeId) return [];
    const target = String(nodeId);
    const results = [];

    for (const edge of this.edges.values()) {
      if (edge.status !== 'active') continue;
      if (!canAccessMemoryScope(edge, normScope, opts)) continue;
      if (edge.fromId === target || edge.toId === target) {
        results.push(structuredClone(edge));
      }
    }
    return results;
  }

  removeEdgesForRecords(recordIds = [], scope, opts = {}) {
    const normScope = normalizeScope(scope);
    if (!normScope) return 0;
    const idSet = new Set(recordIds.map(String));
    let removed = 0;

    for (const [edgeId, edge] of this.edges.entries()) {
      if (!canAccessMemoryScope(edge, normScope, opts)) continue;
      if (idSet.has(edge.fromId) || idSet.has(edge.toId)) {
        this.edges.delete(edgeId);
        removed += 1;
      }
    }
    return removed;
  }
}
