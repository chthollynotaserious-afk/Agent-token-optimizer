/**
 * Compression Plugin Interface + Single-Compressor Guard + Quality/Cost Gate
 *
 * Guarantees:
 *   1. Content is NEVER passed through two lossy compressors in sequence.
 *   2. Quality Gate (ContextPilot-inspired, default threshold 72/100) + Net Savings Gate:
 *      if quality drops below threshold OR compression increases net cost (e.g. cache rebuild),
 *      safely falls back to the unmodified original content.
 */

import crypto from 'node:crypto';
import { estimateTokens, shouldRewritePrefix } from '../core/cache-economics.js';

export class SingleCompressorCoordinator {
  constructor({
    plugins = [],
    minQualityScore = 72,
    retentionStore = null,
    auditLog = null,
  } = {}) {
    this.plugins = plugins;
    this.minQualityScore = minQualityScore;
    this.retentionStore = retentionStore;
    this.auditLog = auditLog;
  }

  register(plugin) {
    this.plugins.push(plugin);
  }

  _hash(text) {
    return crypto.createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex').slice(0, 16);
  }

  /**
   * Compress a single content item at most once, enforcing quality and cache-cost gates.
   */
  async compressOnce(item, {
    contentType = 'tool_output',
    budgetTokens = null,
    preservePrefix = false,
    expectedRemainingTurns = 1,
    model = 'deepseek-chat',
    alreadyCompressedBy = null,
  } = {}) {
    const raw = typeof item === 'string' ? item : JSON.stringify(item ?? '');
    if (alreadyCompressedBy) {
      return {
        ok: true,
        applied: false,
        content: raw,
        compressedBy: alreadyCompressedBy,
        fallbackReason: 'already_compressed_guard',
      };
    }

    const contentHash = this._hash(raw);
    const candidates = this.plugins.filter(
      (p) => !p.supportedContentTypes || p.supportedContentTypes.includes(contentType)
    );

    for (const plugin of candidates) {
      let available = false;
      try {
        available = await plugin.isAvailable();
      } catch {
        available = false;
      }
      if (!available) continue;

      try {
        const res = await plugin.compress({
          content: raw,
          contentType,
          budgetTokens,
          preservePrefix,
          contentHash,
        });

        if (!res || res.ok !== true || typeof res.content !== 'string') {
          this.auditLog?.log('compression', 'fallback', {
            plugin: plugin.name,
            reason: res?.fallbackReason || 'plugin_returned_not_ok',
          });
          continue;
        }

        const quality = Number(res.qualityScore);
        if (Number.isFinite(quality) && quality < this.minQualityScore) {
          this.auditLog?.log('compression', 'quality_gate_reject', {
            plugin: plugin.name,
            quality,
            minQualityScore: this.minQualityScore,
          });
          return {
            ok: true,
            applied: false,
            content: raw,
            fallbackReason: `quality_below_${this.minQualityScore}`,
          };
        }

        const beforeTokens = estimateTokens(raw);
        const afterTokens = estimateTokens(res.content);
        const tokensSaved = Math.max(0, beforeTokens - afterTokens);

        if (preservePrefix && res.mutatedPrefixTokens > 0) {
          const econ = shouldRewritePrefix({
            tokensSaved,
            invalidatedPrefixTokens: res.mutatedPrefixTokens,
            expectedRemainingTurns,
            compressionOverheadCost: Number(res.overheadCost) || 0,
            model,
          });
          if (!econ.worthwhile) {
            this.auditLog?.log('compression', 'cache_gate_reject', {
              plugin: plugin.name,
              netExpectedSavings: econ.netExpectedSavings,
            });
            return {
              ok: true,
              applied: false,
              content: raw,
              fallbackReason: 'cache_rebuild_cost_exceeds_savings',
            };
          }
        }

        // Optionally retain original before returning compressed text
        let originalRefId = res.originalRefId || null;
        if (!originalRefId && this.retentionStore && tokensSaved > 0) {
          const retained = this.retentionStore.retain({ toolName: contentType, rawOutput: raw });
          originalRefId = retained.refId;
        }

        return {
          ok: true,
          applied: true,
          content: res.content,
          compressedBy: plugin.name,
          originalRefId,
          qualityScore: Number.isFinite(quality) ? quality : null,
          tokensSaved,
        };
      } catch (err) {
        this.auditLog?.log('compression', 'plugin_error_fallback', {
          plugin: plugin.name,
          error: err?.message || String(err),
        });
      }
    }

    // Fallback to built-in lossless retention handle if raw exceeds inline limit
    if (this.retentionStore && contentType === 'tool_output') {
      const retained = this.retentionStore.retain({ toolName: contentType, rawOutput: raw });
      if (retained.retained) {
        return {
          ok: true,
          applied: true,
          content: retained.inlineText,
          compressedBy: 'builtin-retention',
          originalRefId: retained.refId,
          tokensSaved: Math.max(0, estimateTokens(raw) - estimateTokens(retained.inlineText)),
        };
      }
    }

    return {
      ok: true,
      applied: false,
      content: raw,
      fallbackReason: 'no_compression_applied',
    };
  }
}
