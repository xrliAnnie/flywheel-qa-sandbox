# Exploration: QA·FLY-849 harness round 3 — full-auto three-stage marker — FLY-855

**Issue**: FLY-855 (QA·FLY-849 harness round 3 — full auto three-stage run, sandbox only)
**Date**: 2026-07-04
**Based on**: FLY-851 round-1 design (`engineering/doc/FLY-851-three-stage-smoke-marker/exploration.md`), FLY-853 round-2 marker
**Status**: Complete

## Problem

FLY-849 combined-batch QA 的第 3 轮验证：**full auto** 三阶段管线（Design=Fable → Implement=Opus → QA=Sonnet），全程真实运行、无人工模拟。本 issue 是注入载体——任务刻意琐碎（创建一个 markdown 标记文件），被测对象是**真实的多模型阶段交接**，不是交付物本身。

**Sandbox only，绝不进生产派发。**

## Scope（issue 原文锁死）

产物只有一个文件：`doc/qa/harness/FLY-849-round3-marker.md`，内容为：

1. 一行标题：`# FLY-849 round 3 marker`
2. 一句话：注明这是 full-auto 三阶段验证轮（Design=Fable, Implement=Opus, QA=Sonnet, no manual simulation）。

PR 开向 `qa/fly849-793-batch-combined`（sandbox mirror），只新增这一个文件。

## Research（先例核查，折入本文档）

- **Round 1（FLY-851）**：设计阶段提交 `engineering/doc/FLY-851-three-stage-smoke-marker/{exploration.md,progress.md}`；Implement 阶段写 `doc/qa/harness/FLY-849-smoke-marker.md`（heading 逐字 + 一句话带 UTC 日期）。三方案对比后选静态文件。
- **Round 2（FLY-853）**：marker `doc/qa/harness/FLY-849-round2-marker.md`，同形态（heading + 一句话 + created-on 日期）。
- 本轮完全复用该形态，无新技术问题 → 不需要独立 research 文档。

## Approaches

| # | 方案 | 评价 |
|---|------|------|
| A | **静态文件（选定，同 round 1）**：Implement 阶段直接写死文件内容，日期以实现时刻 `date -u +%Y-%m-%d` 取 | 最小、无脚本、完全贴合 issue 文本 |
| B | 生成脚本产出 marker | 多出文件，违反 "single file added"。拒绝 |
| C | marker 里塞 exec-id / 模型版本号等元数据 | issue 只要求"一句话"，YAGNI。拒绝 |

## Design（方案 A）

文件内容（Implement 阶段以 `date -u +%Y-%m-%d` 取日期替换 `<YYYY-MM-DD>`）：

```markdown
# FLY-849 round 3 marker

This is the full-auto three-stage verification round (Design=Fable, Implement=Opus, QA=Sonnet, no manual simulation), created on <YYYY-MM-DD> (UTC).
```

- **heading 必须逐字**等于 `# FLY-849 round 3 marker`（验收标准 1）。
- 正文恰好一句话，含 "full-auto three-stage verification round" 语义 + 括号内三模型分工 + "no manual simulation"；created-on 日期沿用 round 1/2 先例（issue 未强制要求，零成本可追溯性）。
- **Testing**：doc-only 变更，无运行时行为，不写单测；验收 = `test -f` + `grep -Fx` 逐字校验 heading + `grep` 校验句子含 Fable/Opus/Sonnet 与 no manual simulation 字样（写进 plan 的 verification 步骤）。
- **Error handling**：n/a（静态文档）。

## Assumptions（显式列出）

1. **"single file added" 指产品交付物范围**。三阶段管线强制把设计文档 + progress.md 提交到同一分支，PR diff 会同时包含这些过程文档——这是 harness 管线的固有形态，不视为违反验收标准（同 FLY-851 假设 1，round 1 已被接受）。
2. Design 阶段（本阶段）不创建 `doc/qa/harness/FLY-849-round3-marker.md`——那是 Implement 阶段的活。
3. 设计批准：本 Runner 提示词中无 BRAINSTORM GATE block → 按 generic-executor override A 的 no-gate 路径，以非阻塞 `flywheel-comm ask`（question `7f9f73c1`）知会 Lead 并推进，phase 完成前 check 回复。
