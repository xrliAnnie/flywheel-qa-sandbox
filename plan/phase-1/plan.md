# Phase 1 — 语音命令 → 回写 tmux

> **Related overview sections**: [Section 5 (核心流程)](../overview.md#5-核心流程), [Section 6.2 (send-keys)](../overview.md#62-回写选择send-keys), [Section 7.2 (命令词表)](../overview.md#72-命令词表), [Section 9 (安全)](../overview.md#9-安全与误操作防护)

## ⚠️ Phase 0 发现的技术约束

以下发现影响 Phase 1 设计，必须在实现前解决：

### ASR: `hs.speech.listener` 不可用

- **问题**: `hs.speech.listener` (NSSpeechRecognizer) 在 macOS Sonoma 14.5+ 上 `new()` 返回 nil（[Hammerspoon #3529](https://github.com/Hammerspoon/hammerspoon/issues/3529)）
- **影响**: Phase 1 原计划用 `hs.speech.listener` 做语音识别，此路径完全不可用
- **替代方案**（需评估）:
  1. **macOS SFSpeechRecognizer** — 通过 Objective-C bridge 或 AppleScript 调用，本地离线，但 Hammerspoon 没有现成封装
  2. **Whisper.cpp 本地** — Phase 4 原计划方案，可提前引入。延迟 ~1-2s，需要模型文件
  3. **macOS Dictation API** — 系统级语音输入，但无法限定命令词表
  4. **简化为键盘快捷键** — 放弃语音输入，改用 Hammerspoon hotkey（如 Ctrl+1/2/3），保留 TTS 播报
- **建议**: 方案 4（hotkey）最低风险，可快速交付 MVP；方案 2（Whisper）是长期方向

### TTS: 需要两阶段方案

- **问题**: macOS Sequoia 下，Hammerspoon 子进程的实时音频输出静默（`hs.speech`、`say` 直接播放均不工作）
- **已解决**: 使用 `say -o file.aiff`（合成到文件）+ `hs.sound`（播放）的两阶段方案，已验证可用
- **Phase 1 无需额外处理**: tts.lua 已实现正确方案

## 目标

闭环——播报后用语音选择，自动回写

## Tasks

1. 实现 `listener.lua`：ASR 方案选型 + 封装（`hs.speech.listener` 不可用，需替代方案）
2. 实现 `router.lua`：语音命令 → 动作映射
3. 实现 `writer.lua`：`tmux send-keys` 封装 + 回写前校验（pane 存在 + prompt 指纹匹配）
4. 实现 `dispatcher.lua`：TTS → ASR → Router → Writer 的完整状态流转
5. 超时处理：15s 无响应 → 重播
6. 高风险二次确认（`confirm_high_risk = true`）：yes/no 和 approve/reject 类提示默认要求确认
7. 端到端测试：模拟提示 → 播报 → 语音选择 → 验证 pane 收到正确输入

## 验收标准

- 用户说"选一"后 **< 2 秒**，对应 pane 收到 `1\n`
- yes/no 和 approve/reject 提示触发二次确认流程
- 超时 15s 后自动重播
- 回写前 pane 校验 + 指纹重验正常工作

## 预计工作量

约 4-6 小时
