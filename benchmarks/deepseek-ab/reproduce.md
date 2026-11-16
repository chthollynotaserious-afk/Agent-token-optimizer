[English](./reproduce.md) | [简体中文](./reproduce.zh-CN.md)

# Reproducing the UAO × DeepSeek A/B Benchmark

## 1. Zero-Spend Mock Verification

```bash
node benchmarks/deepseek-ab/runner.mjs --mode mock --smoke --reps 2 --max-cny 5
```

## 2. Live DeepSeek API Run (5 RMB Cap)

Set a dedicated test API key in your environment (never commit or log it):

```powershell
# PowerShell
$env:DEEPSEEK_API_KEY = "sk-your-test-key"
node benchmarks/deepseek-ab/runner.mjs --mode live --smoke --reps 1 --max-cny 1
# After verifying smoke output, run full paired benchmark capped at 5 RMB:
node benchmarks/deepseek-ab/runner.mjs --mode live --reps 2 --max-cny 5
```

Generated artifacts in `benchmarks/deepseek-ab/output/`:
- `BENCHMARK_REPORT.md`
- `raw_metrics.csv`
- `fixture_manifest.json`
- `environment.json`
