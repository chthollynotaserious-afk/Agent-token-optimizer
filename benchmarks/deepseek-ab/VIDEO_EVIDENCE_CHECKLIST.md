[English](./VIDEO_EVIDENCE_CHECKLIST.md) | [简体中文](./VIDEO_EVIDENCE_CHECKLIST.zh-CN.md)

# Video Evidence Checklist

Before including any chart, terminal capture, or metric in a public video:

- [ ] Confirm `environment.json` shows `mode: "live"` (never present `mock` numbers as live API savings).
- [ ] Mask all API keys, account IDs, account balances, and private host paths.
- [ ] Show both Arm A (Baseline) and Arm B (UAO) with identical `fixture_manifest.json` hash and model ID.
- [ ] Disclose sample size (`reps`), spending cap (`¥5`), price table version, and any negative/neutral scenarios.
- [ ] Do not claim UAO created DeepSeek's native prompt cache or guarantees fixed savings for all workloads.
