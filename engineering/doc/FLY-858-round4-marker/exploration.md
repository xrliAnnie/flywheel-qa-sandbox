# Exploration: QA·FLY-849 harness round 4 — FLY-856 handoff-leadid-fix verification marker — FLY-858

**Issue**: FLY-858 (QA·FLY-849 harness round 4 — verify FLY-856 handoff-leadid fix: tmux self-close + no unarchive, sandbox only)
**Date**: 2026-07-04
**Based on**: FLY-855 round-3 design (`engineering/doc/FLY-855-round3-marker/exploration.md`, PR #46), FLY-853 round-2 marker, FLY-851 round-1 design
**Status**: Complete

## Problem

FLY-849 combined-batch QA 的第 4 轮验证。combined 分支在 793+795+799+cmux 之上新增了 **FLY-856（PR #442，resolveLeadId fix）**——round 3（FLY-855）暴露的 bug：phase handoff 时 phantom `prev.lead_id` 导致 phase window 无法关闭。本轮以与 round 3 完全相同的 zero-simulation full-auto 三阶段方法（Design=Fable → Implement=Opus → QA=Sonnet）重跑，专门验证：

1. **Implement 与 QA 阶段的 runner tmux window 在 ship 完成后自动自关**。
2. **已归档的 Discord thread 不被残留 runner 的 post 重新打开（unarchive）**。

本 issue 是注入载体——任务刻意琐碎（创建一个 markdown 标记文件），被测对象是**真实的多模型阶段交接 + finalization 行为**，不是交付物本身。

**Sandbox only，绝不进生产派发。**

## Scope（issue 原文锁死）

产物只有一个文件：`doc/qa/harness/FLY-849-round4-marker.md`，内容为：

1. 一行标题：`# FLY-849 round 4 marker`
2. 一句话：注明这是 FLY-856 handoff-leadid-fix 验证轮（Design=Fable, Implement=Opus, QA=Sonnet, no manual simulation）。

PR 开向 `qa/fly849-793-batch-combined`（sandbox mirror），只新增这一个文件。

## Research（先例核查，折入本文档）

- **Round 1（FLY-851）**：三方案对比后选静态文件；marker = heading 逐字 + 一句话带 UTC 日期。
- **Round 2（FLY-853）**：`doc/qa/harness/FLY-849-round2-marker.md`，同形态。
- **Round 3（FLY-855，PR #46）**：`doc/qa/harness/FLY-849-round3-marker.md`，同形态；设计文档 = exploration（research 折入）+ plan + progress，QA 阶段产出 `doc/qa/reports/FLY-855-round3-qa-report.md`。
- **本轮关键环境差异（已实测核查）**：基分支 `qa/fly849-793-batch-combined` 在合入 FLY-856 fix（PR #442，tip `1253524`）时被**重建**，round 1–3 的 merge 不在本分支血统里——`git ls-tree origin/qa/fly849-793-batch-combined doc/qa/harness/` 为空。因此 `doc/qa/harness/` 目录对本分支是**全新目录**，Implement 阶段写文件时会一并创建（round 3 plan 里"目录已存在，无需 mkdir"的说法对本轮**不成立**）。
- 形态完全复用 round 3，无新技术问题 → 不需要独立 research 文档。

## Approaches

| # | 方案 | 评价 |
|---|------|------|
| A | **静态文件（选定，同 round 1–3）**：Implement 阶段直接写死文件内容，日期以实现时刻 `date -u +%Y-%m-%d` 取 | 最小、无脚本、完全贴合 issue 文本 |
| B | 生成脚本产出 marker | 多出文件，违反 "single file added"。拒绝 |
| C | marker 里塞 exec-id / FLY-856 commit SHA 等元数据 | issue 只要求"一句话"，YAGNI。拒绝 |

## Design（方案 A）

文件内容（Implement 阶段以 `date -u +%Y-%m-%d` 取日期替换 `<YYYY-MM-DD>`）：

```markdown
# FLY-849 round 4 marker

This is the FLY-856 handoff-leadid-fix verification round (Design=Fable, Implement=Opus, QA=Sonnet, no manual simulation), created on <YYYY-MM-DD> (UTC).
```

- **heading 必须逐字**等于 `# FLY-849 round 4 marker`（验收标准 1）。
- 正文恰好一句话，含 "FLY-856 handoff-leadid-fix verification round" 语义 + 括号内三模型分工 + "no manual simulation"；created-on 日期沿用 round 1–3 先例。
- **Testing**：doc-only 变更，无运行时行为，不写单测；验收 = `test -f` + `grep -Fx` 逐字校验 heading + `grep -E` 校验句子含 FLY-856/Fable/Opus/Sonnet 与 no manual simulation 字样（写进 plan 的 verification 步骤）。
- **Error handling**：n/a（静态文档）。

## 本轮验证点归属（重要）

Issue 列出的两个验证点——**(1) Implement/QA runner tmux window ship 后自关；(2) 归档 thread 不被 unarchive**——是 **Bridge/cmux 侧的运行时行为**，由 harness/Lead（及盯守本轮的 QA 观察者）在本轮流水线真实跑动时**带外观察**。marker 文件与三份 phase 文档本身无法、也不应断言这两点；本 Runner 能贡献的是**如实走完全自动三阶段流程**（不模拟、不跳 gate、不人工代打），让被测行为在真实路径上发生。QA 阶段报告应记录其可从 PR/repo 侧核验的验收标准，带外两点由 harness 侧结论为准。

## Assumptions（显式列出）

1. **"single file added" 指产品交付物范围**。三阶段管线强制把设计文档 + progress.md 提交到同一分支，PR diff 会同时包含这些过程文档——这是 harness 管线的固有形态，不视为违反验收标准（round 1–3 已被接受的同款假设）。
2. Design 阶段（本阶段）不创建 `doc/qa/harness/FLY-849-round4-marker.md`——那是 Implement 阶段的活。
3. 设计批准：本 Runner 提示词中无 BRAINSTORM GATE block → 按 generic-executor override A 的 no-gate 路径，以非阻塞 `flywheel-comm ask`（question `18106d26`）知会 Lead 并推进。**Lead 已回复 Approved**（确认单文件 marker、mkdir 新目录、PR base、两个带外验证点归 harness 观察，"No further changes requested"）——本设计为 Lead 批准态，非仅 best-judgment。
4. 往轮 marker（round 1–3）不在本分支血统里是**基分支重建的预期结果**，不需要也不应该把它们补回来——验收只要求 round-4 文件。
