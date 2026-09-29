# FLY-3058 QA-SBX probe — 探索
Issue: FLY-3058 (https://linear.app/geoforge3d/issue/FLY-3058/qa-sbx-fly-2922-qa4-fixture-529-generalized-real-drill)
日期: 2026-09-29
基于: 无

## 目标

这是只在 `xrliAnnie/flywheel-qa-sandbox` 使用的 QA 流程夹具。它验证实现节点先提交一个精确的 round-1 标记，QA 打回后实现节点再在同一分支、同一 PR 上补 attempt-2 标记。

## 必须成立的状态

- Round 1 新建 `qa-2922/probe.txt`，内容恰为 `PROBE-1\n`。
- Round 1 不得出现 `PROBE-2`。
- QA 要求 rework 后，只在原文件末尾追加 `PROBE-2\n`；最终内容恰为 `PROBE-1\nPROBE-2\n`。
- Rework 继续使用原分支和原 PR，不另开 PR。
- 实现阶段除 `qa-2922/probe.txt` 外不改其他文件；本 design 节点只提交流程要求的设计产物，不创建目标文件。

## 可选方案

1. **推荐：直接写入并逐轮做精确字节校验。** Round 1 一次性写出第一行；rework 用追加操作写第二行。步骤最少，且每轮都能用 `git diff` 和字节级命令证明状态。
2. **用 patch 逐轮修改目标文件。** 可读性尚可，但对只有两行的夹具增加了不必要的上下文匹配面。
3. **新增脚本或自动化测试生成标记。** 可复用性没有实际收益，还会违反“无其他实现文件变化”的边界。

采用方案 1。失败时不猜测或扩展范围：内容、路径、分支或 PR 任一不符合，就停在当前轮修正后再交付。
