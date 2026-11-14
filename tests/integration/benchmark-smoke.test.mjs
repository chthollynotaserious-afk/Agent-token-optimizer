import assert from 'node:assert/strict';
import test from 'node:test';
import { runAllBenchmarks } from '../benchmark/run-benchmark.mjs';

test('Universal Benchmark Suite executes all 10 scenarios with zero regressions and positive savings', async () => {
  const report = await runAllBenchmarks();
  assert.equal(report.dataSourceMode, 'simulated');
  assert.equal(report.scenarios.length, 10);

  for (const s of report.scenarios) {
    assert.equal(s.dataSourceMode, 'simulated');
    assert.equal(s.optimized.regressionRate, 0, `${s.id} must have 0% task quality regression`);
    assert.ok(s.optimized.netSavings > 0, `${s.id} must yield positive net savings`);
    assert.equal(s.optimized.taskSuccessRate, 1.0, `${s.id} task assertions must pass 100%`);
  }
});
