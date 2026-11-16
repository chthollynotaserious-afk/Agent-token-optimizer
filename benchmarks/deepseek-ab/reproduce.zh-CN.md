[English](./reproduce.md) | [简体中文](./reproduce.zh-CN.md)

# UAO × DeepSeek A/B Benchmark 复现指南

## 1. 零费用 Mock 验证

```bash
node benchmarks/deepseek-ab/runner.mjs --mode mock --smoke --reps 2 --max-cny 5
```

## 2. 真实 DeepSeek API 实测（5 元上限保护）

在环境变量中设置测试专用 API Key（严禁写入代码或日志）：

```powershell
# PowerShell
$env:DEEPSEEK_API_KEY = "sk-your-test-key"
node benchmarks/deepseek-ab/runner.mjs --mode live --smoke --reps 1 --max-cny 1
# 确认 Smoke 输出与账本无误后，运行 5 元上限完整配对测试：
node benchmarks/deepseek-ab/runner.mjs --mode live --reps 2 --max-cny 5
```

生成产物位于 `benchmarks/deepseek-ab/output/`：
- `BENCHMARK_REPORT.md`
- `raw_metrics.csv`
- `fixture_manifest.json`
- `environment.json`
