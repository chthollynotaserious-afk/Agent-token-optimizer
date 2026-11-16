import type { UniversalAgentOptimizer } from 'universal-agent-optimizer';

export declare const name: 'uao-optimizer';

export declare const inject: string[];

export interface UaoDshConfig {
  enabled?: boolean;
  mode?: 'observe' | 'govern';
  ledgerFile?: string | null;
  defaultProvider?: string;
}

export interface UaoDshService {
  name: string;
  config: Readonly<{
    enabled: boolean;
    mode: 'observe' | 'govern';
    ledgerFile: string | null;
    defaultProvider: string;
  }>;
  optimizer: UniversalAgentOptimizer | null;
  isDisposed(): boolean;
  getStatus(): {
    plugin: string;
    enabled: boolean;
    mode: 'observe' | 'govern';
    disposed: boolean;
    dshServices: {
      tokenMeter: boolean;
      session: boolean;
      llm: boolean;
    };
    metrics: Record<string, unknown> | null;
  };
  getMetrics(): Record<string, unknown> | null;
  prepareRequest(request?: Record<string, unknown>): Promise<Record<string, unknown>>;
  recordUsage(ctx?: Record<string, unknown>, response?: Record<string, unknown>, prepared?: Record<string, unknown>): Promise<Record<string, unknown> | null>;
  dispose(): void;
}

export declare function resolveDshConfig(rawConfig?: Record<string, unknown>): UaoDshService['config'];
export declare function createUaoDshService(ctx: any, rawConfig?: Record<string, unknown>): UaoDshService;
export declare function apply(ctx: any, config?: UaoDshConfig): UaoDshService;

declare const plugin: {
  name: typeof name;
  inject: typeof inject;
  apply: typeof apply;
  resolveDshConfig: typeof resolveDshConfig;
  createUaoDshService: typeof createUaoDshService;
};

export default plugin;
