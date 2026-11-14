/**
 * CostTracker: aggregates baseline vs optimized net savings across sessions and agents.
 */
import { evaluateOptimizationEconomics } from '../core/cache-economics.js';
import { DEFAULT_PRICE_TABLE } from '../core/model-prices.js';

export class CostTracker {
  constructor({ priceTable = DEFAULT_PRICE_TABLE } = {}) {
    this.priceTable = priceTable;
    this.records = [];
  }

  trackStep({
    sessionId,
    model,
    provider,
    baselineUsage,
    optimizedUsage,
    overheadCost = 0,
    rebuildPenaltyTokens = 0,
    observed = false,
    at = Date.now(),
  }) {
    const econ = evaluateOptimizationEconomics({
      baselineUsage,
      optimizedUsage,
      overheadCost,
      rebuildPenaltyTokens,
      model,
      provider,
      at,
      table: this.priceTable,
      observed,
    });
    const rec = { sessionId, at, ...econ };
    this.records.push(rec);
    return rec;
  }

  report() {
    let baselineCost = 0;
    let optimizedTotalCost = 0;
    let netSavings = 0;
    let observedCount = 0;
    let estimatedCount = 0;
    let negativeCount = 0;

    for (const r of this.records) {
      baselineCost += r.baselineCost;
      optimizedTotalCost += r.optimizedTotalCost;
      netSavings += r.netSavings;
      if (r.dataSource === 'observed') observedCount += 1;
      else estimatedCount += 1;
      if (r.netSavings < 0) negativeCount += 1;
    }

    return {
      steps: this.records.length,
      observedCount,
      estimatedCount,
      negativeSavingsSteps: negativeCount,
      baselineCost,
      optimizedTotalCost,
      netSavings,
      savingsPct: baselineCost > 0 ? (netSavings / baselineCost) * 100 : 0,
      currency: this.priceTable.currency,
      symbol: this.priceTable.symbol,
    };
  }
}
