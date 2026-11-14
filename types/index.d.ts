import type http from 'node:http';

export interface UsageBuckets {
  cacheMiss: number;
  cacheHit: number;
  cacheWrite: number;
  output: number;
  reasoning: number;
}

export interface ModelRates {
  tier: string;
  estimated: boolean;
  cacheMiss: number;
  cacheHit: number;
  cacheWrite: number;
  output: number;
  reasoning: number;
}

export interface PriceModelEntry {
  label: string;
  provider: string;
  off: Omit<ModelRates, 'tier' | 'estimated'>;
  peak?: Omit<ModelRates, 'tier' | 'estimated'>;
}

export interface PriceTable {
  version: string;
  currency: string;
  symbol: string;
  unit: string;
  peakMultiplier: number;
  peakWindows: unknown[];
  peakWeekdays: number[];
  holidays: string[];
  defaultModel: string;
  models: Record<string, PriceModelEntry>;
}

export interface PricedUsageResult {
  buckets: UsageBuckets;
  rates: ModelRates;
  cost: {
    cacheMiss: number;
    cacheHit: number;
    cacheWrite: number;
    output: number;
    reasoning: number;
    input?: number;
    total: number;
    costSource: 'upstream' | 'table';
  };
}

export interface CacheProfile {
  provider: string;
  minPrefixTokens: number;
  cacheHitMultiplier: number;
  cacheWriteMultiplier: number;
  ttlSeconds: number;
  mode: string;
}

export interface PrefixStabilityReport {
  prefixIntact: boolean;
  reason: string;
  toolSchemaChanged: boolean;
  sharedPrefixTokens: number;
}

export interface OptimizationEconomicsReport {
  baselineCost: number;
  optimizedApiCost: number;
  overheadCost: number;
  cacheRebuildPenalty: number;
  totalOptimizedCost: number;
  netSavings: number;
  netSavingsPct: number;
  profitable: boolean;
  dataSource: 'observed' | 'estimated';
}

export interface AgentMessage {
  role: string;
  content: unknown;
  _compressedBy?: string | null;
  [key: string]: unknown;
}

export interface PrepareRequestContext {
  agentId?: string;
  sessionId?: string;
  conversationKey?: string;
  provider?: string;
  model?: string;
  scene?: string;
  staticText?: string;
  subBlocks?: Record<string, unknown>;
  contextItems?: unknown[];
  messages?: AgentMessage[];
  tools?: Array<Record<string, unknown>>;
  allowedTools?: string[];
  deniedTools?: string[];
  currentInputTokens?: number;
  forceFullStatic?: boolean;
  dedupConfig?: Record<string, unknown>;
  now?: number;
  onBeforeRotate?: (ctx: Record<string, unknown>) => Promise<void> | void;
  verifyPersistence?: (ctx: Record<string, unknown>) => Promise<boolean> | boolean;
  verifyRecovery?: (ctx: Record<string, unknown>) => Promise<boolean> | boolean;
}

export interface PreparedRequest {
  sessionId: string;
  conversationKey: string;
  rotated: boolean;
  rolledBack: boolean;
  handoffText: string | null;
  staticText: string;
  emittedSubBlocks: Record<string, unknown>;
  emittedItems: unknown[];
  stateSignals: Record<string, unknown>;
  recalledMemories?: Record<string, unknown> | null;
  messages: AgentMessage[];
  tools: Array<Record<string, unknown>>;
  toolGovernance: Record<string, unknown>;
  cacheCheck: PrefixStabilityReport;
  _pendingDedupCommit: unknown;
  estimatedInputTokens: number;
}

export interface OptimizerResponse {
  usage?: Record<string, unknown>;
  observed?: boolean;
  overheadCost?: number;
  baselineUsage?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface LedgerEntry {
  ts: number;
  agentId: string;
  sessionId: string;
  conversationKey: string;
  provider: string;
  model: string;
  turn: number;
  step: number;
  buckets: UsageBuckets;
  cost: PricedUsageResult['cost'];
  overheadCost: number;
  totalCost: number;
  tier: string;
  estimatedPrice: boolean;
  dataSource: 'observed' | 'estimated';
  metadata?: Record<string, unknown>;
}

export interface OptimizerMetrics {
  ledger: ReturnType<UniversalTokenLedger['summary']>;
  costComparison: ReturnType<CostTracker['report']>;
  cache: ReturnType<CacheTracker['stats']>;
  auditCount: number;
  memory?: {
    records: number;
    archives: number;
  };
}

export class UniversalAgentOptimizer {
  memoryStore: UniversalMemoryStore;
  constructor(config?: Record<string, unknown>);
  beforeWake(triggerEvent: Record<string, unknown>): Promise<Record<string, unknown>>;
  getBuiltinTools(opts?: {
    format?: 'openai' | 'anthropic' | 'mcp';
    includeRetrieve?: boolean;
    includeRecall?: boolean;
  }): Array<Record<string, unknown>>;
  executeBuiltinToolCall(
    call: Record<string, unknown>,
    trustedCtx?: Record<string, unknown>
  ): Record<string, unknown>;
  extractAndSaveMemory(opts?: Record<string, unknown>): Promise<Record<string, unknown>>;
  recallMemory(opts?: Record<string, unknown>): Record<string, unknown>;
  prepareRequest(ctx?: PrepareRequestContext): Promise<PreparedRequest>;
  manageToolResult(
    toolCall: Record<string, unknown>,
    rawResult: unknown,
    opts?: { contentType?: string; model?: string; alreadyCompressedBy?: string | null }
  ): Promise<Record<string, unknown>>;
  retrieveToolResult(
    refId: string,
    opts?: { startLine?: number; endLine?: number; query?: string }
  ): Record<string, unknown> | null;
  afterResponse(
    ctx?: PrepareRequestContext,
    response?: OptimizerResponse,
    prepared?: PreparedRequest | null
  ): Promise<LedgerEntry>;
  optimizeRequest(
    ctx: PrepareRequestContext & {
      handleBuiltinTools?: boolean;
      maxToolRounds?: number;
      invokeUpstream: (preparedPayload: Record<string, unknown>) => Promise<OptimizerResponse>;
    }
  ): Promise<{
    response: OptimizerResponse;
    prepared: PreparedRequest;
    entry: LedgerEntry;
    builtinToolRounds?: number;
    executedBuiltinTools?: Array<Record<string, unknown>>;
    telemetry: Record<string, unknown>;
  }>;
  getMetrics(): OptimizerMetrics;
}

export const DEFAULT_PRICE_TABLE: PriceTable;
export const LEGACY_CNY_PRICE_TABLE: PriceTable;
export const ZERO_BUCKETS: Readonly<UsageBuckets>;

export function normalizeUsage(usage?: Record<string, unknown>): UsageBuckets;
export function priceUsage(
  usage?: Record<string, unknown>,
  opts?: { model?: string; at?: number; table?: PriceTable }
): PricedUsageResult;
export function ratesAt(opts?: {
  model?: string;
  at?: number;
  table?: PriceTable;
}): ModelRates;
export function createPriceTable(overrides?: Partial<PriceTable>): PriceTable;

export const PROVIDER_CACHE_PROFILES: Record<string, CacheProfile>;
export function getCacheProfile(provider?: string): CacheProfile;
export function estimateTokens(input: unknown): number;
export function analyzePrefixStability(opts: {
  prevMessages?: AgentMessage[];
  nextMessages?: AgentMessage[];
  prevToolSchemaHash?: string | null;
  nextToolSchemaHash?: string | null;
  minPrefixTokens?: number;
}): PrefixStabilityReport;
export function evaluateOptimizationEconomics(opts: {
  baselineUsage?: Record<string, unknown>;
  optimizedUsage?: Record<string, unknown>;
  model?: string;
  provider?: string;
  overheadCost?: number;
  cacheRebuildPenalty?: number;
  observed?: boolean;
  priceTable?: PriceTable;
}): OptimizationEconomicsReport;
export function shouldRewritePrefix(opts: {
  cachedTokens?: number;
  expectedRemainingTurns?: number;
  savedTokensPerTurn?: number;
  provider?: string;
  model?: string;
}): { allowed: boolean; reason: string; breakEvenTurns?: number };

export const DEFAULT_LIFECYCLE_LIMITS: Record<string, unknown>;
export function evaluateRotationNeed(
  state: Record<string, unknown>,
  opts?: Record<string, unknown>
): Record<string, unknown>;
export function buildUniversalHandoff(
  messages?: AgentMessage[],
  opts?: Record<string, unknown>
): string;

export class SessionLifecycleController {
  constructor(opts?: Record<string, unknown>);
  consumePendingHandoff(state: Record<string, unknown>): string | null;
  rotateIfNeeded(
    key: string,
    state: Record<string, unknown>,
    globalState: Record<string, unknown>,
    opts?: Record<string, unknown>
  ): Promise<Record<string, unknown>>;
}

export const PRIORITY_LEVELS: Record<string, number>;
export const DEFAULT_INVOCATION_CONFIG: Record<string, unknown>;

export class InvocationController {
  constructor(opts?: Record<string, unknown>);
  evaluateWake(event: Record<string, unknown>): Promise<Record<string, unknown>>;
}

export function computeSchemaHash(tools?: Array<Record<string, unknown>>): string;
export class ToolGovernance {
  constructor(opts?: Record<string, unknown>);
  govern(opts?: Record<string, unknown>): Record<string, unknown>;
}

export const DEFAULT_UNIVERSAL_DEDUP_CONFIG: Record<string, unknown>;
export function evaluateUniversalDedup(opts?: Record<string, unknown>): Record<string, unknown>;
export function commitUniversalDedupState(
  prevState: Record<string, unknown> | null,
  pendingCommit: unknown,
  now?: number
): Record<string, unknown> | null;

export class ToolResultRetentionStore {
  maxInlineChars: number;
  constructor(opts?: Record<string, unknown>);
  retain(rawText: string, meta?: Record<string, unknown>): Record<string, unknown>;
  retrieve(
    refId: string,
    opts?: { startLine?: number; endLine?: number; query?: string }
  ): Record<string, unknown> | null;
}

export function canAccessScope(
  record: Record<string, unknown>,
  requestCtx: Record<string, unknown>
): boolean;
export function redactSecrets(text?: string): string;
export function selectUniversalContext(opts: {
  records?: Array<Record<string, unknown>>;
  requestCtx?: Record<string, unknown>;
  maxChars?: number;
  [key: string]: unknown;
}): Record<string, unknown>;

export function extractTextContent(content: unknown): string;
export function tokenizeKeywords(text?: string): string[];
export function extractMemoriesFromMessages(
  messages?: Array<Record<string, unknown>>,
  opts?: Record<string, unknown>
): Array<Record<string, unknown>>;

export class UniversalMemoryStore {
  size: number;
  records: Array<Record<string, unknown>>;
  archives: Array<Record<string, unknown>>;
  constructor(opts?: {
    file?: string | null;
    maxEntries?: number;
    maxArchives?: number;
    summarizeFn?: ((ctx: Record<string, unknown>) => Promise<unknown> | unknown) | null;
    now?: () => number;
  });
  addMemory(item?: Record<string, unknown>): Record<string, unknown> | null;
  addMemories(items?: Array<Record<string, unknown>>): Array<Record<string, unknown>>;
  flushSession(opts?: Record<string, unknown>): Promise<Record<string, unknown>>;
  hasVerificationToken(token?: string | null): boolean;
  recall(opts?: Record<string, unknown>): Record<string, unknown>;
}

export const BUILTIN_TOOL_NAMES: Readonly<{
  RETRIEVE_TOOL_OUTPUT: string;
  RECALL_MEMORY: string;
}>;
export function getBuiltinToolSpecs(opts?: {
  includeRetrieve?: boolean;
  includeRecall?: boolean;
}): Array<Record<string, unknown>>;
export function formatBuiltinTools(
  specs?: Array<Record<string, unknown>>,
  format?: 'openai' | 'anthropic' | 'mcp'
): Array<Record<string, unknown>>;
export function isBuiltinToolName(name?: string): boolean;
export function extractToolCalls(response: unknown): Record<string, unknown> | null;
export function executeBuiltinToolCall(
  optimizer: UniversalAgentOptimizer,
  call: Record<string, unknown>,
  trustedCtx?: Record<string, unknown>
): Record<string, unknown>;
export function runBuiltinToolLoop(opts: {
  optimizer: UniversalAgentOptimizer;
  initialPayload: Record<string, unknown>;
  meta?: Record<string, unknown>;
  invokeUpstream: (payload: Record<string, unknown>, round: number) => Promise<Record<string, unknown>>;
  onResponse?: ((response: Record<string, unknown>, payload: Record<string, unknown>, round: number) => Promise<void> | void) | null;
  maxRounds?: number;
}): Promise<{
  response: Record<string, unknown>;
  rounds: number;
  executedCalls: Array<Record<string, unknown>>;
  finalPayload: Record<string, unknown>;
}>;

export class BaseAgentAdapter {
  constructor(opts?: { name?: string; optimizer?: UniversalAgentOptimizer });
  beforeRequest(ctx?: PrepareRequestContext): Promise<PreparedRequest>;
  afterResponse(
    ctx?: PrepareRequestContext,
    response?: OptimizerResponse,
    prepared?: PreparedRequest | null
  ): Promise<LedgerEntry>;
}

export class OpenAICompatibleAdapter extends BaseAgentAdapter {
  constructor(opts?: { optimizer?: UniversalAgentOptimizer; provider?: string });
  transformRequest(
    payload?: Record<string, unknown>,
    meta?: Record<string, unknown>
  ): Promise<{ payload: Record<string, unknown>; prepared: PreparedRequest }>;
  runWithTools(
    payload: Record<string, unknown>,
    invokeUpstreamFn: (payload: Record<string, unknown>, prepared: PreparedRequest, round: number) => Promise<Record<string, unknown>>,
    meta?: Record<string, unknown>
  ): Promise<Record<string, unknown>>;
  recordResponse(
    meta?: Record<string, unknown>,
    response?: Record<string, unknown>,
    prepared?: PreparedRequest | null
  ): Promise<LedgerEntry>;
}

export class AnthropicAdapter extends BaseAgentAdapter {
  constructor(opts?: { optimizer?: UniversalAgentOptimizer });
  transformRequest(
    payload?: Record<string, unknown>,
    meta?: Record<string, unknown>
  ): Promise<{ payload: Record<string, unknown>; prepared: PreparedRequest }>;
  runWithTools(
    payload: Record<string, unknown>,
    invokeUpstreamFn: (payload: Record<string, unknown>, prepared: PreparedRequest, round: number) => Promise<Record<string, unknown>>,
    meta?: Record<string, unknown>
  ): Promise<Record<string, unknown>>;
  recordResponse(
    meta?: Record<string, unknown>,
    response?: Record<string, unknown>,
    prepared?: PreparedRequest | null
  ): Promise<LedgerEntry>;
}

export class CustomAgentAdapter extends BaseAgentAdapter {
  constructor(opts?: { optimizer?: UniversalAgentOptimizer; agentId?: string });
  runTurn(
    ctx: PrepareRequestContext,
    invokeModelFn: (prepared: PreparedRequest) => Promise<OptimizerResponse>
  ): Promise<Record<string, unknown>>;
}

export class MCPToolAdapter {
  constructor(opts?: { optimizer?: UniversalAgentOptimizer });
  wrapToolCall(
    toolCall: Record<string, unknown>,
    executor: (call: Record<string, unknown>) => Promise<unknown>,
    opts?: Record<string, unknown>
  ): Promise<Record<string, unknown>>;
  getBuiltinTools(opts?: Record<string, unknown>): Array<Record<string, unknown>>;
  handleBuiltinToolCall(
    name: string,
    args?: Record<string, unknown>,
    ctx?: Record<string, unknown>
  ): Promise<Record<string, unknown>>;
}

export class LangGraphAdapter {
  constructor(opts?: { optimizer?: UniversalAgentOptimizer });
  wrapNode(
    nodeFn: (state: Record<string, unknown>) => Promise<Record<string, unknown>>,
    meta?: Record<string, unknown>
  ): (state: Record<string, unknown>) => Promise<Record<string, unknown>>;
}

export class NoopStateProvider {
  getContextSignals(ctx?: Record<string, unknown>): Promise<Record<string, unknown>>;
  shouldSuppressWake(event?: Record<string, unknown>): Promise<boolean>;
}

export class CompanionStateProvider {
  constructor(opts?: Record<string, unknown>);
  getContextSignals(ctx?: Record<string, unknown>): Promise<Record<string, unknown>>;
  shouldSuppressWake(event?: Record<string, unknown>): Promise<boolean>;
}

export class SingleCompressorCoordinator {
  constructor(opts?: Record<string, unknown>);
  compressOnce(
    content: string,
    opts?: { contentType?: string; model?: string; alreadyCompressedBy?: string | null }
  ): Promise<Record<string, unknown>>;
}

export class CircuitBreaker {
  constructor(opts?: { failureThreshold?: number; cooldownMs?: number });
  canExecute(now?: number): boolean;
  recordSuccess(): void;
  recordFailure(now?: number): void;
}

export class HeadroomPlugin {
  constructor(opts?: Record<string, unknown>);
  compress(content: string, opts?: Record<string, unknown>): Promise<Record<string, unknown>>;
}

export class ContextCompressPlugin {
  constructor(opts?: Record<string, unknown>);
  compress(content: string, opts?: Record<string, unknown>): Promise<Record<string, unknown>>;
}

export class RTKPlugin {
  constructor(opts?: Record<string, unknown>);
  compress(content: string, opts?: Record<string, unknown>): Promise<Record<string, unknown>>;
}

export class UniversalTokenLedger {
  constructor(opts?: { file?: string | null; priceTable?: PriceTable; now?: () => number });
  record(entryInput: Record<string, unknown>): LedgerEntry;
  summary(filter?: { agentId?: string | null; sessionId?: string | null; since?: number }): {
    calls: number;
    observedCalls: number;
    estimatedCalls: number;
    buckets: UsageBuckets;
    inputTokens: number;
    totalTokens: number;
    apiCost: number;
    overheadCost: number;
    totalCost: number;
    byModel: Record<string, unknown>;
  };
}

export class CostTracker {
  constructor(opts?: { priceTable?: PriceTable });
  trackStep(stepInput: Record<string, unknown>): Record<string, unknown>;
  report(): Record<string, unknown>;
}

export class CacheTracker {
  inspectRequest(opts: Record<string, unknown>): PrefixStabilityReport;
  stats(): Record<string, unknown>;
}

export class AuditLog {
  entries: Array<Record<string, unknown>>;
  constructor(opts?: { file?: string | null });
  log(event: Record<string, unknown>): void;
}

export function createProxyServer(opts: {
  optimizer?: UniversalAgentOptimizer | null;
  upstreamBaseUrl: string;
  provider?: string;
  fetchImpl?: typeof fetch;
  autoExecuteBuiltinTools?: boolean;
  maxBuiltinToolRounds?: number;
}): http.Server;
