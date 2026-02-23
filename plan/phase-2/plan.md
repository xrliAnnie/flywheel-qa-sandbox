# Phase 2 — 多 pane 自动发现 + 事件队列

> **Related overview sections**: [Section 4 (数据模型)](../overview.md#4-数据模型), [Section 6.3 (pane 发现)](../overview.md#63-pane-发现与监控), [Section 8.2 (解析流程)](../overview.md#82-解析流程)

## 目标

支持多 pane 并行监控 + 排队播报

## Tasks

1. 实现 `queue.lua`：Event 数据结构 + 状态机 + FIFO
2. 实现 pane 自动发现：`tmux list-panes -a` + 过滤 `pane_current_command` 包含 `claude` 或 `node`
3. 同 pane 串行化逻辑
4. 去重逻辑（dedupe_key）
5. 多 pane 端到端测试：2+ pane 同时出现提示 → 按顺序播报和处理

## 验收标准

- 3 个 pane 各出一个提示，按 FIFO 逐个播报，选择正确路由
- 自动发现能识别运行 Claude Code 的 pane
- 同一提示不重复入队（dedupe 正常工作）
- 同 pane 多个事件按检测顺序串行处理

## 预计工作量

约 6-8 小时
