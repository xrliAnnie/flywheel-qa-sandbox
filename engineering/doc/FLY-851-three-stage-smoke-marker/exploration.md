# Exploration: QA·FLY-849 harness — three-stage smoke marker — FLY-851

**Issue**: FLY-851 (QA·FLY-849 harness — three-stage batch integration smoke, sandbox only)
**Date**: 2026-07-04
**Status**: Complete

## Problem

FLY-849 combined-batch QA（793+795+799+cmux）需要给 529 Room test slot 注入一个**真实的 Linear issue** 来验证三阶段管线（Design → Implement → QA）的编排本身。本 issue 是那个注入载体：任务刻意琐碎——创建一个 markdown 标记文件——被测对象是管线编排，不是功能复杂度。

**Sandbox only，绝不进生产派发。**

## Scope（issue 原文锁死）

产物只有一个文件：`doc/qa/harness/FLY-849-smoke-marker.md`，内容为：

1. 一行标题：`# FLY-849 combined-batch smoke marker`
2. 一句话：注明当前 UTC-ish 日期 + 该文件由 three-stage QA harness 创建。

PR 开向 `qa/fly849-793-batch-combined`（sandbox mirror），只新增这一个文件。

## Resume 上下文（本设计为重做）

前一个 runner（ba8b9cb5）的三个 commit（ff1a078 / a5cdc19 / f4d7220）经核实**只包含 progress.md**（`flywheel-comm progress` 是 path-limited 提交）——exploration/research/plan 从未落盘。故 cursor "3/4, next=design_review" 不可信，设计文档全部重做。

## Approaches

| # | 方案 | 评价 |
|---|------|------|
| A | **静态文件（推荐）**：Implement 阶段用实现时刻的 UTC 日期直接写死文件内容 | 最小、无脚本、完全贴合 issue 文本。选定 |
| B | 加一个生成脚本产出 marker | 多出一个文件，违反 "no other files touched"。拒绝 |
| C | marker 里塞 exec-id / 链接等元数据 | issue 只要求"一句话"，YAGNI。拒绝 |

## Design（方案 A）

文件内容（Implement 阶段以 `date -u +%Y-%m-%d` 取日期）：

```markdown
# FLY-849 combined-batch smoke marker

This file was created on <YYYY-MM-DD> (UTC) by the three-stage QA harness (FLY-851) as a combined-batch integration smoke marker.
```

- **heading 必须逐字**等于 `# FLY-849 combined-batch smoke marker`（验收标准 1）。
- 正文恰好一句话，含 UTC 日期 + "created by the three-stage QA harness" 语义。
- Implement 阶段：`mkdir -p doc/qa/harness/` → 写文件 → commit（`docs(FLY-851): add FLY-849 combined-batch smoke marker`）→ PR against `qa/fly849-793-batch-combined`。
- **Testing**：doc-only 变更，无运行时行为，不写单测；验收 = `test -f` + `grep -Fx` 逐字校验 heading + 句子含日期与 harness 字样（写进 plan 的 verification 步骤）。
- **Error handling**：n/a（静态文档）。

## Assumptions（显式列出）

1. **"single file added" 指产品交付物范围**。三阶段管线本身强制把 exploration/research/plan + progress.md 提交到同一分支，所以 PR diff 会同时包含这些过程文档（前一 runner 的 progress commit 已在分支上）。这是 harness 管线的固有形态，不视为违反验收标准。
2. "UTC-ish date" 取 Implement 执行时刻的 UTC 日期（YYYY-MM-DD），不要求时分秒。
3. Design 阶段（本阶段）不创建 `doc/qa/harness/` 目录、不写 marker 文件——那是 Implement 阶段的活。
