/**
 * External Optimizer Plugin Adapters (P2)
 *
 * Bridges optional third-party tools (Headroom, context-compress, RTK) behind a unified
 * CompressionPlugin interface with availability probing, timeouts, circuit breaking,
 * and automatic safe fallback to unmodified content.
 *
 * NOTE: None of these third-party binaries/services are bundled or required.
 */

export class CircuitBreaker {
  constructor({ failureThreshold = 3, resetTimeoutMs = 30_000, now = () => Date.now() } = {}) {
    this.failureThreshold = failureThreshold;
    this.resetTimeoutMs = resetTimeoutMs;
    this.now = now;
    this.failures = 0;
    this.openedAt = 0;
  }

  isOpen() {
    if (this.failures < this.failureThreshold) return false;
    if (this.now() - this.openedAt >= this.resetTimeoutMs) {
      this.failures = 0;
      this.openedAt = 0;
      return false;
    }
    return true;
  }

  recordSuccess() {
    this.failures = 0;
    this.openedAt = 0;
  }

  recordFailure() {
    this.failures += 1;
    if (this.failures >= this.failureThreshold) {
      this.openedAt = this.now();
    }
  }
}

export class HeadroomPlugin {
  constructor({
    baseUrl = 'http://127.0.0.1:8787',
    timeoutMs = 2000,
    fetchImpl = globalThis.fetch,
    breaker = new CircuitBreaker(),
  } = {}) {
    this.name = 'headroom';
    this.supportedContentTypes = ['tool_output', 'history', 'rag_chunk'];
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
    this.breaker = breaker;
  }

  async isAvailable() {
    if (this.breaker.isOpen() || typeof this.fetchImpl !== 'function') return false;
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/health`, {
        signal: AbortSignal.timeout(Math.min(this.timeoutMs, 1000)),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async compress({ content, contentType, budgetTokens }) {
    if (this.breaker.isOpen()) {
      return { ok: false, content, fallbackReason: 'circuit_breaker_open' };
    }
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/v1/compress`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content, content_type: contentType, budget_tokens: budgetTokens }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!res.ok) {
        this.breaker.recordFailure();
        return { ok: false, content, fallbackReason: `http_${res.status}` };
      }
      const data = await res.json();
      if (typeof data?.compressed !== 'string') {
        this.breaker.recordFailure();
        return { ok: false, content, fallbackReason: 'invalid_payload' };
      }
      this.breaker.recordSuccess();
      return {
        ok: true,
        content: data.compressed,
        originalRefId: data.ref_id || null,
        qualityScore: data.quality_score,
        overheadCost: Number(data.overhead_cost) || 0,
      };
    } catch (err) {
      this.breaker.recordFailure();
      return { ok: false, content, fallbackReason: err?.message || 'headroom_unreachable' };
    }
  }
}

export class ContextCompressPlugin {
  constructor({ invokeMcpTool = null, breaker = new CircuitBreaker() } = {}) {
    this.name = 'context-compress';
    this.supportedContentTypes = ['tool_output'];
    this.invokeMcpTool = invokeMcpTool;
    this.breaker = breaker;
  }

  async isAvailable() {
    return !this.breaker.isOpen() && typeof this.invokeMcpTool === 'function';
  }

  async compress({ content, contentType }) {
    if (!(await this.isAvailable())) {
      return { ok: false, content, fallbackReason: 'context_compress_unavailable' };
    }
    try {
      const res = await this.invokeMcpTool('compress_and_index', { content, contentType });
      if (!res || typeof res.summary !== 'string') {
        this.breaker.recordFailure();
        return { ok: false, content, fallbackReason: 'invalid_mcp_response' };
      }
      this.breaker.recordSuccess();
      return {
        ok: true,
        content: res.summary,
        originalRefId: res.refId || null,
        qualityScore: res.qualityScore ?? 85,
      };
    } catch (err) {
      this.breaker.recordFailure();
      return { ok: false, content, fallbackReason: err?.message || 'context_compress_error' };
    }
  }
}

export class RTKPlugin {
  constructor({ runFilter = null, breaker = new CircuitBreaker() } = {}) {
    this.name = 'rtk';
    this.supportedContentTypes = ['cli_log'];
    this.runFilter = runFilter;
    this.breaker = breaker;
  }

  async isAvailable() {
    return !this.breaker.isOpen() && typeof this.runFilter === 'function';
  }

  async compress({ content }) {
    if (!(await this.isAvailable())) {
      return { ok: false, content, fallbackReason: 'rtk_unavailable' };
    }
    try {
      const out = await this.runFilter(content);
      if (typeof out !== 'string' || !out) {
        this.breaker.recordFailure();
        return { ok: false, content, fallbackReason: 'empty_rtk_output' };
      }
      this.breaker.recordSuccess();
      return { ok: true, content: out, qualityScore: 85 };
    } catch (err) {
      this.breaker.recordFailure();
      return { ok: false, content, fallbackReason: err?.message || 'rtk_error' };
    }
  }
}
