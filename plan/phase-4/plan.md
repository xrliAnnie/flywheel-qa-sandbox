# Phase 4 — Whisper 升级 + 自由语音（可选）

> **Related overview sections**: [Section 2 (路线 C)](../overview.md#路线-c-whisper自由语音), [Section 7.2 (命令词表)](../overview.md#72-命令词表)

## 目标

支持更自然的语音命令

## Tasks

1. 集成 `whisper.cpp`（本地推理）
2. 支持自然语言指令解析（"帮我 approve A，B 稍后"）
3. 混合模式：小词表用 `hs.speech.listener`（低延迟），超出词表时 fallback Whisper
4. 评估延迟和准确率 trade-off
5. （可选）中文命令词增强（如果 Phase 0 gate 未通过）

## 验收标准

- Whisper 本地推理延迟 < 3s
- 自然语言指令正确解析率 >= 80%
- 混合模式下，小词表命令延迟不受影响（仍 < 500ms）
- 延迟和准确率 trade-off 评估报告

## 预计工作量

约 8-12 小时
