[English](./VIDEO_EVIDENCE_CHECKLIST.md) | [简体中文](./VIDEO_EVIDENCE_CHECKLIST.zh-CN.md)

# 宣传视频证据核对清单

在视频中展示任何图表、终端录屏或数据前，必须逐项核对：

- [ ] 确认 `environment.json` 为 `mode: "live"`（严禁将 `mock` 模拟结果冒充真实 API 节省）。
- [ ] 遮盖所有 API Key、账号 ID、账户余额与私人本地路径。
- [ ] 同时展示 A 组（Baseline）与 B 组（UAO），并确保 `fixture_manifest.json` 哈希与模型 ID 完全一致。
- [ ] 如实标注样本量（`reps`）、预算上限（`¥5`）、价格表版本，以及任何中性/负向结果。
- [ ] 不宣称 UAO 创造了 DeepSeek 原生 Prompt Cache，也不宣称对所有场景保证固定节省比例。
