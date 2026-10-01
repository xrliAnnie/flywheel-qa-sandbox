# FLY-3121 Canary 传输探针 — 调研
Issue: FLY-3121 (https://linear.app/geoforge3d/issue/FLY-3121/529-canary-fly2127-canary-eeb549be-1af1-44c6-93d3-a0cb7f40022c-phase)
日期: 2026-10-01
基于: exploration.md

## 相关机制
- **TURN**:`flywheel-comm turn` 打印 `yours|not-yours|no-turn`;只有 `yours` 才能写共享 worktree。`not-yours` 是正常等待态。
- **回执**:向 Lead 报告必须走 `flywheel-comm ask --report`,不得用 SendMessage。
- **完成**:`flywheel-comm complete --route phase_design_complete`。

## 结论
标记追加是纯文本 append(`>>`),幂等性不是要求(每个节点各追加一行，行内带 exec/activation 可区分)。无需新增脚本或测试。
