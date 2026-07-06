# Exploration: QA sandbox fixture — sandbox-notes.md 固定任务 — FLY-202

**Issue**: FLY-202 (QA sandbox fixture — slot harness real-Runner E2E task (do not pick up)) — https://linear.app/geoforge3d/issue/FLY-202/qa-sandbox-fixture-slot-harness-real-runner-e2e-task-do-not-pick-up
**Date**: 2026-07-05
**基于**: 沙箱快照 `a227d4e`(orphan commit,分支 `project-slot-2-FLY-202`)、`packages/qa-framework/README.md`、`doc/qa/qa-context.md`

## Problem Statement

FLY-202 是 QA test-slot 框架(FLY-96 / FLY-115)的**固定 fixture issue**:它存在的目的是让 `scripts/inject-linear-issue.sh` / `POST /api/runs/start` 有一个真实的、PreHydrator 可见的 Linear issue,用来在隔离 slot 里 spawn 一个真实 Runner 并观察其完整 pipeline 行为。任务本身刻意设计为"小、稳、多步",给 QA 一个 mid-work 观察窗口。

本次 dispatch 是**三阶段 pipeline(Design → Implement → QA)的 Design 阶段**:只产出设计文档(exploration / research / plan)并提交到共享分支 `project-slot-2-FLY-202`,不写实现。

## Issue 要求的实现任务(Implement 阶段的合同)

1. 创建 `doc/qa/sandbox-notes.md`,用 2-3 段说明 `flywheel-qa-sandbox` 仓库的用途。
2. 追加一个表格,列出仓库**每个顶层目录**及一行描述。
3. 追加一节,用约 10 个 bullet 总结 `packages/qa-framework/README.md`。
4. 运行 `ls -R doc/ | head -50`,把输出放进 fenced code block。
5. 在 feature branch 上提交,并向沙箱仓库 main 开 PR。

约束:所有工作留在沙箱克隆内,不碰生产资源。

## Context Findings

- **沙箱形态**:`/private/tmp/flywheel-test-slot-2/project-slot-2-FLY-202` 是 `xrliAnnie/flywheel-qa-sandbox` 的克隆,内容为 Flywheel 主仓的 orphan 快照(单 commit `a227d4e`,无历史)。当前分支即三阶段共享分支。
- **顶层目录**(实测 11 个):`agents/ doc/ docs/ engineering/ fleet/ packages/ patches/ qa-fly294/ qa-fly310/ scripts/ supabase/`。注意实现时必须**现场重新枚举**(`ls -F | grep '/$'`),不可硬编码本清单——每次 E2E 快照的树可能不同。
- **`doc/qa/sandbox-notes.md` 在本分支不存在**,是全新创建(沙箱 main 上历史 E2E 运行可能已有同名文件,但本分支从快照出发,直接 create)。
- **历史先例**:FLY-202 已被多次 E2E 运行消费(sandbox PR #27~#43),PR 标题惯例如 `docs(FLY-202): refresh QA sandbox notes — slot-2 real-Runner E2E re-run`。
- **qa-framework README**(316 行)结构:框架定位、两层架构、5-Step Protocol、Test Slot 框架(FLY-115)、FLY-60 suite、Mirror Mode(FLY-153)、Roundtable/Alert Mirror(FLY-529)、Contracts——足以支撑 ~10 bullet 的总结。
- **founder-UX 判定**:纯沙箱内文档任务,founder 不直接看到 → 不触发 founder_ux_gate。
- **TDD 判定**:doc-only 变更,无运行时面 → 单测不适用,以结构性验证清单代替(见 plan)。

## Approaches Considered

### A. 一次成稿(单 commit)
整个 `sandbox-notes.md` 一次写完、一个 commit、开 PR。
- 优点:最少步骤。
- 缺点:**违背 issue 本意**——fixture 要求 "small, steady, multi-step — gives QA a mid-work window";单 commit 让 QA 没有中途观察窗口。

### B. 按内容步骤分 commit(推荐)
Issue 的 4 个内容步骤各自一个 commit(共 4 个),每步之间更新 progress ledger,最后开 PR、走 approve gate。
- 优点:忠实还原 issue 设计意图,给 QA 稳定的 mid-work 窗口;progress ledger 让 restart/resume 可从真实 cursor 续跑。
- 缺点:commit 数略多——但这正是 fixture 想要的形态。

### C. 脚本化生成文档
写一个可重复执行的生成脚本再由脚本产出 markdown。
- 缺点:对一个 fixture 文档任务是明显的过度工程,违反 simplicity 原则。放弃。

**结论:选 B。**

## Key Decisions(headless 自决,已在 brainstorm gate 向 Lead 报备)

| # | 决策 | 理由 |
|---|------|------|
| D1 | 设计文档落 `doc/qa/FLY-202-sandbox-notes/`(exploration/research/plan/progress 同文件夹) | Baseline PROGRESS LEDGER 要求 progress.md 与设计文档同文件夹;任务属 QA 域,落 `doc/qa/` 与交付物同区 |
| D2 | Implement 阶段沿用共享分支 `project-slot-2-FLY-202`,不另开分支 | 三阶段 pipeline 明确 "all on ONE shared branch";该分支即 issue 要求的 feature branch |
| D3 | 顶层目录表只列目录(不含顶层文件),实现时现场枚举 | issue 原文 "every top-level directory";快照树可能变化 |
| D4 | `ls -R doc/ | head -50` 在沙箱克隆根目录执行,输出逐字粘贴 | issue 原文即为此命令;逐字粘贴保可复核性 |
| D5 | doc-only,TDD 豁免,以 plan 中的结构性验证清单代替 | 无运行时面可驱动;验证 = 章节齐全性/表行数=目录数/fenced block 存在 |
