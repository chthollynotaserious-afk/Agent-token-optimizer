/**
 * UAO Layered Memory Architecture — Scope-First Retriever & Multi-Factor Ranker (Phase 2)
 *
 * Retrieval is strictly separated from prompt injection:
 * - Scope filtering happens BEFORE relevance scoring.
 * - Irrelevant memories below `minRelevanceScore` are excluded by default.
 */

import { estimateTokens } from '../core/cache-economics.js';
import { canAccessMemoryScope, normalizeScope } from './scope.js';

const DEFAULT_WEIGHTS = Object.freeze({
  relevance: 0.45,
  recency: 0.2,
  importance: 0.15,
  confidence: 0.15,
  tokenCostPenalty: 0.05,
});

function tokenize(text) {
  return String(text ?? '')
    .toLowerCase()
    .split(/[^a-z0-9\u4e00-\u9fff_]+/i)
    .filter((t) => t.length >= 2);
}

export function computeKeywordRelevance(queryText, content) {
  const qTokens = tokenize(queryText);
  if (qTokens.length === 0) return 0;
  const body = typeof content === 'string' ? content : JSON.stringify(content ?? '');
  const hay = body.toLowerCase();
  let hits = 0;
  for (const tok of qTokens) {
    if (hay.includes(tok)) hits += 1;
  }
  return hits / qTokens.length;
}

export class MemoryRetriever {
  constructor({
    provider,
    auditLog = null,
    minRelevanceScore = 0.2,
    weights = {},
  } = {}) {
    if (!provider) {
      throw new TypeError('MemoryRetriever: provider is required');
    }
    this.provider = provider;
    this.auditLog = auditLog;
    this.minRelevanceScore = minRelevanceScore;
    this.weights = { ...DEFAULT_WEIGHTS, ...weights };
  }

  async retrieve({
    queryText = '',
    scope,
    kind = null,
    limit = 10,
    now = Date.now(),
    enabled = true,
    minRelevanceScore = this.minRelevanceScore,
    includeSensitive = false,
    allowCrossScopeDimensions = [],
  } = {}) {
    const start = Date.now();
    const normScope = normalizeScope(scope);
    if (!enabled || !normScope) {
      return {
        enabled: Boolean(enabled),
        retrieved: [],
        stats: {
          candidatesEvaluated: 0,
          returnedCount: 0,
          filteredIrrelevant: 0,
          latencyMs: Date.now() - start,
        },
      };
    }

    // 1. Scope-first query at provider boundary
    const rawCandidates = await this.provider.queryRecords(
      { kind, status: 'active', limit: 500 },
      normScope,
      { includeSensitive, allowCrossScopeDimensions }
    );

    // 2. Defense-in-depth scope verification
    const authorized = rawCandidates.filter((rec) =>
      canAccessMemoryScope(rec, normScope, { includeSensitive, allowCrossScopeDimensions })
    );

    const hasQuery = typeof queryText === 'string' && queryText.trim().length > 0;
    const scored = [];
    let filteredIrrelevant = 0;

    for (const record of authorized) {
      const relevance = hasQuery ? computeKeywordRelevance(queryText, record.content) : 0.5;
      if (hasQuery && relevance < minRelevanceScore) {
        filteredIrrelevant += 1;
        continue;
      }

      const updatedMs = Date.parse(String(record.updated_at || record.created_at || '')) || now;
      const ageHours = Math.max(0, (now - updatedMs) / 3_600_000);
      const recency = Math.exp(-ageHours / 168);
      const importance = Number.isFinite(Number(record.importance)) ? Number(record.importance) : 0.5;
      const confidence = Number.isFinite(Number(record.confidence)) ? Number(record.confidence) : 0.5;
      const tokenCount = estimateTokens(
        typeof record.content === 'string' ? record.content : JSON.stringify(record.content ?? '')
      );
      const costPenalty = Math.min(1, tokenCount / 1000);

      const score = (
        this.weights.relevance * relevance
        + this.weights.recency * recency
        + this.weights.importance * importance
        + this.weights.confidence * confidence
        - this.weights.tokenCostPenalty * costPenalty
      );

      scored.push({
        record,
        score: Number(score.toFixed(4)),
        relevance: Number(relevance.toFixed(4)),
        recency: Number(recency.toFixed(4)),
        tokenCount,
      });
    }

    scored.sort((a, b) => b.score - a.score);
    const maxItems = Number.isInteger(limit) && limit > 0 ? limit : 10;
    const retrieved = scored.slice(0, maxItems);

    if (this.auditLog && typeof this.auditLog.log === 'function') {
      this.auditLog.log('memory', 'retrieve', {
        candidatesEvaluated: authorized.length,
        returnedCount: retrieved.length,
        filteredIrrelevant,
      });
    }

    return {
      enabled: true,
      retrieved,
      stats: {
        candidatesEvaluated: authorized.length,
        returnedCount: retrieved.length,
        filteredIrrelevant,
        latencyMs: Date.now() - start,
      },
    };
  }
}
