/**
 * Multi-provider model pricing & usage normalization table.
 * Supports DeepSeek (peak/off-peak), OpenAI, Anthropic, Google Gemini, and Local LLMs,
 * while maintaining full compatibility with legacy Denia token-ledger & tool-cost-attribution callers.
 */

export const ZERO_BUCKETS = Object.freeze({
  cacheMiss: 0,
  cacheHit: 0,
  cacheWrite: 0,
  output: 0,
  reasoning: 0,
});

const USD_TO_CNY_APPROX = 7.2;

function per1M(cacheMiss, cacheHit, output, { cacheWrite = cacheMiss, reasoning = output } = {}) {
  return { cacheMiss, cacheHit, cacheWrite, output, reasoning };
}

export const DEFAULT_PRICE_TABLE = {
  version: '2026-11-14-universal-v1',
  currency: 'USD',
  symbol: '$',
  unit: 'per_1m_tokens',
  peakMultiplier: 1,
  peakWindows: [],
  peakWeekdays: [],
  holidays: [],
  defaultModel: 'deepseek-chat',
  models: {
    // DeepSeek (USD standard; peak/off-peak can be configured per table)
    'deepseek-chat': {
      label: 'DeepSeek Chat / V3',
      provider: 'deepseek',
      off: per1M(0.27, 0.07, 1.10),
    },
    'deepseek-flash': {
      label: 'DeepSeek Flash (CNY-compat alias)',
      provider: 'deepseek',
      off: per1M(1.0 / USD_TO_CNY_APPROX, 0.25 / USD_TO_CNY_APPROX, 4.0 / USD_TO_CNY_APPROX),
      peak: per1M(2.0 / USD_TO_CNY_APPROX, 0.5 / USD_TO_CNY_APPROX, 8.0 / USD_TO_CNY_APPROX),
    },
    'deepseek-reasoner': {
      label: 'DeepSeek Reasoner (R1)',
      provider: 'deepseek',
      off: per1M(0.55, 0.14, 2.19),
    },
    // OpenAI
    'gpt-4o': {
      label: 'OpenAI GPT-4o',
      provider: 'openai',
      off: per1M(2.50, 1.25, 10.00),
    },
    'gpt-4o-mini': {
      label: 'OpenAI GPT-4o mini',
      provider: 'openai',
      off: per1M(0.15, 0.075, 0.60),
    },
    'gpt-4.1': {
      label: 'OpenAI GPT-4.1',
      provider: 'openai',
      off: per1M(2.00, 0.50, 8.00),
    },
    'o3-mini': {
      label: 'OpenAI o3-mini',
      provider: 'openai',
      off: per1M(1.10, 0.55, 4.40),
    },
    // Anthropic (cacheWrite carries 1.25x 5-min write surcharge; cacheHit carries 0.1x discount)
    'claude-sonnet-4': {
      label: 'Anthropic Claude Sonnet 4',
      provider: 'anthropic',
      off: per1M(3.00, 0.30, 15.00, { cacheWrite: 3.75 }),
    },
    'claude-3-5-haiku': {
      label: 'Anthropic Claude 3.5 Haiku',
      provider: 'anthropic',
      off: per1M(0.80, 0.08, 4.00, { cacheWrite: 1.00 }),
    },
    'claude-opus-4': {
      label: 'Anthropic Claude Opus 4',
      provider: 'anthropic',
      off: per1M(15.00, 1.50, 75.00, { cacheWrite: 18.75 }),
    },
    // Google Gemini
    'gemini-2.5-flash': {
      label: 'Google Gemini 2.5 Flash',
      provider: 'gemini',
      off: per1M(0.15, 0.0375, 0.60, { reasoning: 3.50 }),
    },
    'gemini-2.5-pro': {
      label: 'Google Gemini 2.5 Pro',
      provider: 'gemini',
      off: per1M(1.25, 0.3125, 10.00),
    },
    // Local / Free
    'local-llm': {
      label: 'Local Self-Hosted LLM',
      provider: 'local',
      off: per1M(0, 0, 0),
    },
  },
};

/**
 * Legacy CNY price table compatible with original Denia DeepSeek off-peak/peak schedule (00:00-08:00 off-peak, else 2x).
 */
export const LEGACY_CNY_PRICE_TABLE = {
  version: '2026-11-11-cny-legacy',
  currency: 'CNY',
  symbol: '¥',
  unit: 'per_1m_tokens',
  peakMultiplier: 2,
  peakWindows: ['08:00-24:00'],
  peakWeekdays: [0, 1, 2, 3, 4, 5, 6],
  holidays: [],
  defaultModel: 'deepseek-flash',
  models: {
    'deepseek-flash': {
      label: 'DeepSeek Flash (CNY)',
      provider: 'deepseek',
      off: per1M(1.0, 0.25, 4.0),
      peak: per1M(2.0, 0.5, 8.0),
    },
  },
};

const nonNegInt = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
};

/**
 * Normalize usage objects from OpenAI, Anthropic, Gemini, DeepSeek, LiteLLM, or internal bucket format.
 */
export function normalizeUsage(raw) {
  if (!raw || typeof raw !== 'object') return { ...ZERO_BUCKETS };

  // Already in canonical bucket shape
  if (
    Object.hasOwn(raw, 'cacheMiss')
    || Object.hasOwn(raw, 'cacheHit')
    || Object.hasOwn(raw, 'cacheWrite')
  ) {
    return {
      cacheMiss: nonNegInt(raw.cacheMiss),
      cacheHit: nonNegInt(raw.cacheHit),
      cacheWrite: nonNegInt(raw.cacheWrite),
      output: nonNegInt(raw.output ?? raw.outputTokens),
      reasoning: nonNegInt(raw.reasoning ?? raw.reasoningTokens),
    };
  }

  // Anthropic format: input_tokens excludes cache_read and cache_creation
  if (Object.hasOwn(raw, 'input_tokens') || Object.hasOwn(raw, 'cache_read_input_tokens')) {
    return {
      cacheMiss: nonNegInt(raw.input_tokens),
      cacheHit: nonNegInt(raw.cache_read_input_tokens),
      cacheWrite: nonNegInt(raw.cache_creation_input_tokens),
      output: nonNegInt(raw.output_tokens),
      reasoning: nonNegInt(raw.thinking_tokens ?? raw.reasoning_tokens),
    };
  }

  // Gemini format
  if (Object.hasOwn(raw, 'promptTokenCount') || Object.hasOwn(raw, 'candidatesTokenCount')) {
    const promptTotal = nonNegInt(raw.promptTokenCount);
    const cached = Math.min(promptTotal, nonNegInt(raw.cachedContentTokenCount));
    return {
      cacheMiss: Math.max(0, promptTotal - cached),
      cacheHit: cached,
      cacheWrite: 0,
      output: nonNegInt(raw.candidatesTokenCount),
      reasoning: nonNegInt(raw.thoughtsTokenCount),
    };
  }

  // OpenAI / DeepSeek / LiteLLM format
  if (
    Object.hasOwn(raw, 'prompt_tokens')
    || Object.hasOwn(raw, 'completion_tokens')
    || Object.hasOwn(raw, 'inputTokens')
  ) {
    const promptTotal = nonNegInt(raw.prompt_tokens ?? raw.inputTokens);
    const explicitMiss = raw.prompt_cache_miss_tokens;
    const explicitHit = raw.prompt_cache_hit_tokens ?? raw.prompt_tokens_details?.cached_tokens ?? raw.cachedTokens;
    const cacheHit = explicitHit !== undefined ? Math.min(promptTotal, nonNegInt(explicitHit)) : 0;
    const cacheMiss = explicitMiss !== undefined
      ? nonNegInt(explicitMiss)
      : Math.max(0, promptTotal - cacheHit);
    const reasoning = nonNegInt(
      raw.completion_tokens_details?.reasoning_tokens
      ?? raw.reasoning_tokens
      ?? raw.reasoningTokens
    );
    const completionTotal = nonNegInt(raw.completion_tokens ?? raw.outputTokens);
    const output = Math.max(0, completionTotal - reasoning);
    return {
      cacheMiss,
      cacheHit,
      cacheWrite: nonNegInt(raw.cacheWrite ?? raw.cache_creation_tokens),
      output,
      reasoning,
    };
  }

  return {
    cacheMiss: nonNegInt(raw.input),
    cacheHit: 0,
    cacheWrite: 0,
    output: nonNegInt(raw.output),
    reasoning: nonNegInt(raw.reasoning),
  };
}

export function addBuckets(a = ZERO_BUCKETS, b = ZERO_BUCKETS) {
  return {
    cacheMiss: (Number(a?.cacheMiss) || 0) + (Number(b?.cacheMiss) || 0),
    cacheHit: (Number(a?.cacheHit) || 0) + (Number(b?.cacheHit) || 0),
    cacheWrite: (Number(a?.cacheWrite) || 0) + (Number(b?.cacheWrite) || 0),
    output: (Number(a?.output) || 0) + (Number(b?.output) || 0),
    reasoning: (Number(a?.reasoning) || 0) + (Number(b?.reasoning) || 0),
  };
}

export function inputTokensOf(buckets) {
  if (!buckets) return 0;
  return (Number(buckets.cacheMiss) || 0)
    + (Number(buckets.cacheHit) || 0)
    + (Number(buckets.cacheWrite) || 0);
}

export function totalTokensOf(buckets) {
  if (!buckets) return 0;
  return inputTokensOf(buckets)
    + (Number(buckets.output) || 0)
    + (Number(buckets.reasoning) || 0);
}

function parseWindow(win) {
  const m = /^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/.exec(String(win || '').trim());
  if (!m) return null;
  return {
    startMin: Number(m[1]) * 60 + Number(m[2]),
    endMin: Number(m[3]) * 60 + Number(m[4]),
  };
}

export function isPeakAt(at = Date.now(), table = DEFAULT_PRICE_TABLE) {
  const windows = Array.isArray(table?.peakWindows) ? table.peakWindows : [];
  if (windows.length === 0) return false;
  const d = new Date(Number(at) || Date.now());
  const weekdays = Array.isArray(table?.peakWeekdays) ? table.peakWeekdays : [0, 1, 2, 3, 4, 5, 6];
  if (weekdays.length > 0 && !weekdays.includes(d.getDay())) return false;
  const mins = d.getHours() * 60 + d.getMinutes();
  for (const w of windows) {
    const parsed = parseWindow(w);
    if (!parsed) continue;
    if (mins >= parsed.startMin && mins < parsed.endMin) return true;
  }
  return false;
}

function findExactCaseInsensitive(models, target) {
  if (!target) return null;
  if (models[target]) return models[target];
  const lower = target.toLowerCase();
  for (const [k, entry] of Object.entries(models)) {
    if (k.toLowerCase() === lower) return entry;
  }
  return null;
}

function resolveModelEntry(model, table = DEFAULT_PRICE_TABLE) {
  const models = table?.models || DEFAULT_PRICE_TABLE.models;
  const key = String(model || '').trim();
  if (key && models[key]) return { entry: models[key], estimated: false };

  if (key) {
    const tagMatch = /:([a-z0-9._-]+)$/i.exec(key);
    const routingTag = tagMatch ? tagMatch[1].toLowerCase() : null;
    if (routingTag === 'free') {
      const vendor = key.includes('/') ? key.split('/')[0].toLowerCase() : 'openrouter';
      return {
        entry: {
          label: `${key} (Free tier)`,
          provider: vendor === 'google' ? 'gemini' : vendor,
          off: per1M(0, 0, 0),
        },
        estimated: false,
      };
    }

    const withoutTag = tagMatch ? key.slice(0, tagMatch.index) : key;
    const leaf = withoutTag.includes('/') ? withoutTag.split('/').pop() : withoutTag;
    const dotNormalizedLeaf = leaf.replace(/(\d+)\.(\d+)/g, '$1-$2');
    const hasRoutingTag = Boolean(routingTag);

    for (const candidate of [withoutTag, leaf, dotNormalizedLeaf]) {
      const exact = findExactCaseInsensitive(models, candidate);
      if (exact) return { entry: exact, estimated: hasRoutingTag };
    }

    // Longest-key-first fuzzy match so specific variants (e.g. "gpt-4o-mini")
    // always win over shorter prefixes (e.g. "gpt-4o").
    const sortedEntries = Object.entries(models).sort((a, b) => b[0].length - a[0].length);
    const needles = [leaf.toLowerCase(), dotNormalizedLeaf.toLowerCase()];

    for (const [candidate, entry] of sortedEntries) {
      const candLower = candidate.toLowerCase();
      if (needles.some((n) => n.startsWith(candLower))) {
        return { entry, estimated: true };
      }
    }
    for (const [candidate, entry] of sortedEntries) {
      const candLower = candidate.toLowerCase();
      if (needles.some((n) => n.includes(candLower))) {
        return { entry, estimated: true };
      }
    }
  }

  const fallbackKey = table?.defaultModel || 'deepseek-chat';
  return {
    entry: models[fallbackKey] || Object.values(models)[0],
    estimated: Boolean(key),
  };
}

export function ratesAt(model, at = Date.now(), table = DEFAULT_PRICE_TABLE) {
  const { entry, estimated } = resolveModelEntry(model, table);
  const peak = isPeakAt(at, table);
  const base = entry?.off || per1M(0, 0, 0);
  const mult = peak ? (Number(table?.peakMultiplier) || 1) : 1;
  const selected = peak && entry?.peak
    ? entry.peak
    : {
        cacheMiss: base.cacheMiss * mult,
        cacheHit: base.cacheHit * mult,
        cacheWrite: (base.cacheWrite ?? base.cacheMiss) * mult,
        output: base.output * mult,
        reasoning: (base.reasoning ?? base.output) * mult,
      };
  return {
    tier: peak ? 'peak' : 'off',
    estimated,
    ...selected,
  };
}

export function priceUsage(rawUsage, { model, at = Date.now(), table = DEFAULT_PRICE_TABLE } = {}) {
  const buckets = normalizeUsage(rawUsage);
  const rates = ratesAt(model, at, table);
  const scale = 1 / 1_000_000;

  const rawCostVal = rawUsage && typeof rawUsage === 'object'
    ? (rawUsage.cost ?? rawUsage.total_cost)
    : undefined;
  const hasUpstreamCost = rawCostVal !== undefined
    && rawCostVal !== null
    && rawCostVal !== ''
    && Number.isFinite(Number(rawCostVal))
    && Number(rawCostVal) >= 0;
  const upstreamCost = hasUpstreamCost ? Number(rawCostVal) : null;

  const cost = {
    cacheMiss: upstreamCost === 0 ? 0 : buckets.cacheMiss * rates.cacheMiss * scale,
    cacheHit: upstreamCost === 0 ? 0 : buckets.cacheHit * rates.cacheHit * scale,
    cacheWrite: upstreamCost === 0 ? 0 : buckets.cacheWrite * rates.cacheWrite * scale,
    output: upstreamCost === 0 ? 0 : buckets.output * rates.output * scale,
    reasoning: upstreamCost === 0 ? 0 : buckets.reasoning * rates.reasoning * scale,
    total: 0,
    costSource: hasUpstreamCost ? 'upstream' : 'table',
  };
  const tableTotal = cost.cacheMiss + cost.cacheHit + cost.cacheWrite + cost.output + cost.reasoning;
  cost.total = hasUpstreamCost ? upstreamCost : tableTotal;
  return { buckets, rates, cost };
}

export function createPriceTable(overrides = {}) {
  return {
    ...DEFAULT_PRICE_TABLE,
    ...overrides,
    models: {
      ...DEFAULT_PRICE_TABLE.models,
      ...(overrides.models || {}),
    },
  };
}
