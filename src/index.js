/**
 * Universal Agent Optimizer - Main Public Entry Point
 */

export { UniversalAgentOptimizer } from './core/optimizer.js';
export {
  DEFAULT_PRICE_TABLE,
  LEGACY_CNY_PRICE_TABLE,
  ZERO_BUCKETS,
  normalizeUsage,
  priceUsage,
  ratesAt,
  createPriceTable,
} from './core/model-prices.js';
export {
  PROVIDER_CACHE_PROFILES,
  getCacheProfile,
  estimateTokens,
  analyzePrefixStability,
  evaluateOptimizationEconomics,
  shouldRewritePrefix,
} from './core/cache-economics.js';
export {
  SessionLifecycleController,
  DEFAULT_LIFECYCLE_LIMITS,
  evaluateRotationNeed,
  buildUniversalHandoff,
} from './core/session-lifecycle.js';
export {
  InvocationController,
  PRIORITY_LEVELS,
  DEFAULT_INVOCATION_CONFIG,
} from './core/invocation-controller.js';
export { ToolGovernance, computeSchemaHash } from './core/tool-governance.js';
export {
  evaluateUniversalDedup,
  commitUniversalDedupState,
  DEFAULT_UNIVERSAL_DEDUP_CONFIG,
} from './core/static-context-dedup.js';
export { ToolResultRetentionStore } from './core/tool-output-retention.js';
export { canAccessScope, selectUniversalContext } from './core/context-selector.js';

export { BaseAgentAdapter } from './adapters/base.js';
export { OpenAICompatibleAdapter } from './adapters/openai-compatible.js';
export { AnthropicAdapter } from './adapters/anthropic.js';
export { CustomAgentAdapter, MCPToolAdapter, LangGraphAdapter } from './adapters/custom-agent.js';

export { NoopStateProvider, CompanionStateProvider } from './plugins/state-provider.js';
export { SingleCompressorCoordinator } from './plugins/compression.js';
export {
  CircuitBreaker,
  HeadroomPlugin,
  ContextCompressPlugin,
  RTKPlugin,
} from './plugins/external-optimizer.js';

export { UniversalTokenLedger } from './observability/token-ledger.js';
export { CostTracker } from './observability/cost-tracker.js';
export { CacheTracker } from './observability/cache-tracker.js';
export { AuditLog } from './observability/audit-log.js';

export { createProxyServer } from './proxy/server.js';
