/**
 * DSH (DeepSeek Harness) Cordis Bundle Adapter for Universal Agent Optimizer.
 *
 * Translates Cordis plugin lifecycle and optional DSH services into the
 * framework-neutral UniversalAgentOptimizer core API without duplicating
 * optimization algorithms or monkey-patching DSH internals.
 */

let coreModule;
try {
  coreModule = await import('universal-agent-optimizer');
} catch {
  coreModule = await import('../../../src/index.js');
}
const { UniversalAgentOptimizer } = coreModule;

export const name = 'uao-optimizer';

export const inject = [];

const VALID_MODES = new Set(['observe', 'govern']);

/**
 * Resolve and validate DSH plugin configuration with safe defaults.
 * @param {Record<string, unknown>} [rawConfig]
 */
export function resolveDshConfig(rawConfig = {}) {
  const mode = typeof rawConfig.mode === 'string' && VALID_MODES.has(rawConfig.mode)
    ? rawConfig.mode
    : 'observe';

  return Object.freeze({
    enabled: rawConfig.enabled !== false,
    mode,
    ledgerFile: typeof rawConfig.ledgerFile === 'string' && rawConfig.ledgerFile.trim()
      ? rawConfig.ledgerFile.trim()
      : null,
    defaultProvider: typeof rawConfig.defaultProvider === 'string' && rawConfig.defaultProvider.trim()
      ? rawConfig.defaultProvider.trim()
      : 'deepseek',
  });
}

function hasCordisService(ctx, serviceName) {
  if (!ctx) return false;
  if (typeof ctx.get === 'function') {
    try {
      return Boolean(ctx.get(serviceName));
    } catch {
      return false;
    }
  }
  return Boolean(ctx[serviceName]);
}

/**
 * Create the UAO service facade bound to a Cordis context.
 * @param {any} ctx
 * @param {Record<string, unknown>} [rawConfig]
 */
export function createUaoDshService(ctx, rawConfig = {}) {
  const config = resolveDshConfig(rawConfig);
  const optimizer = config.enabled
    ? new UniversalAgentOptimizer({
        ledgerFile: config.ledgerFile,
      })
    : null;

  let disposed = false;

  const service = {
    name,
    config,
    optimizer,

    isDisposed() {
      return disposed;
    },

    getStatus() {
      return {
        plugin: name,
        enabled: config.enabled,
        mode: config.mode,
        disposed,
        dshServices: {
          tokenMeter: hasCordisService(ctx, 'tokenMeter'),
          session: hasCordisService(ctx, 'session'),
          llm: hasCordisService(ctx, 'llm'),
        },
        metrics: optimizer ? optimizer.getMetrics() : null,
      };
    },

    getMetrics() {
      if (!optimizer) return null;
      return optimizer.getMetrics();
    },

    /**
     * Prepare a model request through the UAO core optimizer.
     * @param {Record<string, unknown>} request
     */
    async prepareRequest(request = {}) {
      if (!optimizer || disposed) {
        return { bypassed: true, payload: request };
      }
      return optimizer.prepareRequest({
        provider: config.defaultProvider,
        ...request,
      });
    },

    /**
     * Record observed or estimated usage into the UAO token ledger.
     * @param {Record<string, unknown>} ctx
     * @param {Record<string, unknown>} response
     * @param {Record<string, unknown>} [prepared]
     */
    async recordUsage(ctx = {}, response = {}, prepared = undefined) {
      if (!optimizer || disposed) return null;
      return optimizer.afterResponse(
        { provider: config.defaultProvider, ...ctx },
        response,
        prepared
      );
    },

    dispose() {
      disposed = true;
    },
  };

  return service;
}

/**
 * Cordis plugin entry point.
 * @param {any} ctx
 * @param {Record<string, unknown>} [config]
 */
export function apply(ctx, config = {}) {
  const service = createUaoDshService(ctx, config);

  if (ctx && typeof ctx.provide === 'function') {
    ctx.provide('uao', service, { immediate: true });
  } else if (ctx && typeof ctx.set === 'function') {
    ctx.set('uao', service);
  }

  if (ctx && typeof ctx.effect === 'function') {
    ctx.effect(() => () => service.dispose(), 'uao.lifecycle');
  } else if (ctx && typeof ctx.on === 'function') {
    ctx.on('dispose', () => {
      service.dispose();
    });
  }

  return service;
}

export default {
  name,
  inject,
  apply,
  resolveDshConfig,
  createUaoDshService,
};
