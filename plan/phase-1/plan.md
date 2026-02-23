# Phase 1 — 语音命令 → 回写 tmux

> **Related overview sections**: [Section 5 (核心流程)](../overview.md#5-核心流程), [Section 6.2 (send-keys)](../overview.md#62-回写选择send-keys), [Section 7.2 (命令词表)](../overview.md#72-命令词表), [Section 9 (安全)](../overview.md#9-安全与误操作防护)

## 目标

闭环——播报后用语音选择，自动回写

## Tasks

1. 实现 `listener.lua`：`hs.speech.listener` 封装 + 命令词表
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
