---
issue: FLY-342
phase: implement
phaseCursor: 4/4 (Annie 4-block 重构)
updated: 2026-07-05
nextStep: commit → 全做完报 Tadashi → 等 review + founder ship (approve gate)
chunks:
  - edge-tts-real: done (首包中位 0.66s, RTF 0.22) — PR #462
  - whisper-stt-real: done (RTF 0.472, 高危反转 5/5 PASS) — PR #462
  - pipeline-demo: done — PR #462
  - hardware-vram-table: done (§9 通用显存分档框架 + 选购 + 云vs本地) — PR #462
  - online-demo-assess: done (§8.6 诚实结论:zh-en 免费 demo 不能干净自动化, 给链接+指标+XHS+本地样本)
  - cosyvoice-local-baseline: done (§8.6.4 CosyVoice2-0.5B CPU 真跑 RTF 3-5, 产出中英混说样本; MPS+全20句 deferred 安全闸)
pointers:
  evidence: engineering/doc/FLY-342-diy-voice-agent/evidence/
  lab: ~/fly342-voice-lab/ (isolated arm64 CosyVoice env, 保留至 QA)
---

# FLY-342 progress
**phase**: implement (4/4 — 内容全完成)
**next**: commit → 报 Tadashi → approve gate 等 founder ship

## 全部完成 (进 PR #462)
1. edge-tts + whisper.cpp 真测 + 端到端 demo (batch-1)
2. §9 硬件 + 通用「显存分档→能跑多大模型」框架 (LLM GLM/Qwen + TTS + 买什么) + 选购建议
3. §8.6 CosyVoice/Qwen3 质量: 在线 demo 诚实评估 + 链接 + 指标 + XHS + 本地样本
4. §8.6.4 CosyVoice2-0.5B 本地 CPU 真跑基准 (RTF 3-5 太慢, 中英混说样本 for Annie)

## deferred (硬件现实 + 安全闸, 非缺陷)
- 大模型(CosyVoice3/Qwen3) 延迟/RTF: 无本地大模型机 → 真硬件(3090修好/Mac Studio 9月底)
- 小模型 MPS + 完整 20 句: memory_pressure flapping yellow → 安全闸停, 等真空闲窗口

## 安全闸留痕
- 隔离 arm64 env, 零全局安装, 零生产配置改动
- CosyVoice CPU 跑时 memory_pressure 到 yellow → 遵守 plan 停止条件, 停 MPS/全量
- 全程 Bridge/Lead 存活, 无 crash, 危险监控已武装并在停止重型后 TaskStop
