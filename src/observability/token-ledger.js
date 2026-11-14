/**
 * Universal Token Ledger
 * Extends cost & token accounting to work standalone with any Agent / Provider
 * (OpenAI, Anthropic, Gemini, DeepSeek, LiteLLM, Local LLM), while preserving
 * compatibility with the original JSONL schema.
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_PRICE_TABLE,
  ZERO_BUCKETS,
  addBuckets,
  inputTokensOf,
  normalizeUsage,
  priceUsage,
  totalTokensOf,
} from '../core/model-prices.js';

export class UniversalTokenLedger {
  constructor({ file = null, priceTable = DEFAULT_PRICE_TABLE, now = () => Date.now() } = {}) {
    this.file = file;
    this.priceTable = priceTable;
    this.now = now;
    this.entries = [];
    if (this.file) this._load();
  }

  _load() {
    try {
      if (!fs.existsSync(this.file)) return;
      const raw = fs.readFileSync(this.file, 'utf8');
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line);
          if (parsed && typeof parsed === 'object') this.entries.push(parsed);
        } catch {}
      }
    } catch {}
  }

  record({
    agentId = 'default',
    sessionId = 'default',
    conversationKey = 'default',
    provider = 'deepseek',
    model = 'deepseek-chat',
    turn = 0,
    step = 0,
    usage,
    observed = true,
    overheadCost = 0,
    metadata = null,
    ts = this.now(),
  }) {
    const buckets = normalizeUsage(usage);
    const priced = priceUsage(buckets, { model, at: ts, table: this.priceTable });
    const entry = {
      ts,
      agentId,
      sessionId,
      conversationKey,
      provider,
      model,
      turn,
      step,
      buckets,
      cost: priced.cost,
      overheadCost: Math.max(0, Number(overheadCost) || 0),
      totalCost: priced.cost.total + Math.max(0, Number(overheadCost) || 0),
      tier: priced.rates.tier,
      estimatedPrice: priced.rates.estimated,
      dataSource: observed ? 'observed' : 'estimated',
      ...(metadata ? { metadata } : {}),
    };
    this.entries.push(entry);
    if (this.file) {
      try {
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        fs.appendFileSync(this.file, `${JSON.stringify(entry)}\n`, 'utf8');
      } catch {}
    }
    return entry;
  }

  summary({ agentId = null, sessionId = null, since = 0 } = {}) {
    let buckets = { ...ZERO_BUCKETS };
    let apiCost = 0;
    let overheadCost = 0;
    let calls = 0;
    let observedCalls = 0;
    let estimatedCalls = 0;
    const byModel = new Map();

    for (const e of this.entries) {
      if (e.ts < since) continue;
      if (agentId && e.agentId !== agentId) continue;
      if (sessionId && e.sessionId !== sessionId) continue;
      calls += 1;
      if (e.dataSource === 'observed') observedCalls += 1;
      else estimatedCalls += 1;
      buckets = addBuckets(buckets, e.buckets);
      apiCost += e.cost.total;
      overheadCost += e.overheadCost;

      const m = byModel.get(e.model) || { model: e.model, calls: 0, cost: 0, inputTokens: 0, outputTokens: 0 };
      m.calls += 1;
      m.cost += e.totalCost;
      m.inputTokens += inputTokensOf(e.buckets);
      m.outputTokens += e.buckets.output + e.buckets.reasoning;
      byModel.set(e.model, m);
    }

    const inputTokens = inputTokensOf(buckets);
    const totalTokens = totalTokensOf(buckets);
    return {
      currency: this.priceTable.currency,
      symbol: this.priceTable.symbol,
      calls,
      observedCalls,
      estimatedCalls,
      buckets,
      inputTokens,
      totalTokens,
      cacheHitRate: inputTokens > 0 ? buckets.cacheHit / inputTokens : null,
      apiCost,
      overheadCost,
      totalCost: apiCost + overheadCost,
      byModel: [...byModel.values()],
    };
  }

  reset() {
    this.entries = [];
    if (this.file) {
      try {
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        fs.writeFileSync(this.file, '', 'utf8');
      } catch {}
    }
  }
}
