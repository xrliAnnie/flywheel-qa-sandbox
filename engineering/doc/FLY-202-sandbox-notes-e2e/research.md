# Research: 仓库事实盘点 — FLY-202（slot-2 E2E 轮）

**Issue**: FLY-202 — https://linear.app/geoforge3d/issue/FLY-202/qa-sandbox-fixture-slot-harness-real-runner-e2e-task-do-not-pick-up
**Date**: 2026-07-19
**基于**: `engineering/doc/FLY-202-sandbox-notes-e2e/exploration.md`；对 tip `7049f719` 的实测

---

## 1. Git / 分支状态

| 事实 | 值 |
|---|---|
| 工作目录 | `/private/tmp/flywheel-test-slot-2/project-slot-2-FLY-202` |
| origin | `https://github.com/xrliAnnie/flywheel-qa-sandbox.git` |
| 当前分支 | `project-slot-2-FLY-202`（harness 创建，clean，无 upstream） |
| tip | `7049f719` `test(FLY-1286): capture failed resident phase E2E (#58)` |
| PR base | sandbox 仓库 `main` |

**结论**：`project-slot-2-FLY-202` 就是本轮的 feature branch——issue step 5 的
「feature branch」不需要另建分支，直接在其上 commit、`push -u origin`、开 PR 即可。
这与历史轮次（#29/#30/#57 均由 slot 分支出 PR）一致。

## 2. 目标文件现状

- `doc/qa/sandbox-notes.md`：**不存在**（#58 移除）→ step 1 为干净新建。
- `packages/qa-framework/README.md`：存在，316 行 / 16,485 bytes。主要 section：
  Architecture、Quick Start、5-Step Protocol、Config Schema、Examples、
  Test Slot Framework（FLY-115，含 Scripts/Pre-requisites/Runner worktree start point）、
  FLY-60 Hard Gate Enforcement E2E（manual-trigger suite）、Mirror Mode（FLY-153）。
  内容量足够支撑 ~10 条 bullet 摘要，implement 段须**通读原文**后归纳，不得照抄本清单。

## 3. 顶层目录清单（step 2 表格的原料，实测于 tip）

12 个目录：`agents`、`doc`、`docs`、`engineering`、`fleet`、`packages`、`patches`、
`product`、`qa-fly294`、`qa-fly310`、`scripts`、`supabase`。

非目录条目（**不进表**）：`CLAUDE.md`、`SETUP.md`、`VISION.md`、`biome.json`、
`memory.db`、`package.json`、`pnpm-lock.yaml`、`pnpm-workspace.yaml`、`review.json`、
`tsconfig.base.json`，以及一个名为 **`=`** 的杂散文件。

⚠️ 陷阱：裸 `ls` 会把 `=` 列在首位；issue 要求的是「every top-level **directory**」。
implement 段应用 `find . -maxdepth 1 -type d` 或逐项 `[ -d ]` 判定，只收目录。

## 4. `doc/` 形状（step 4 的 `ls -R doc/ | head -50` 语境）

`doc/` 顶层：`VERSION`、`architecture/`、`engineer/`、`plan/`、`qa/`、`reference/`、`retro/`。
`doc/qa/` 下有 reports/test-plans/framework 等子目录。`ls -R doc/ | head -50` 输出稳定
可截取；注意 step 1 新建 `doc/qa/sandbox-notes.md` 之后再跑该命令，输出会包含新文件——
顺序上把 step 4 放在 step 1-3 之后执行即符合 issue 排序，无需特殊处理。

## 5. doc-flow / 三段式配置

- `.flywheel/config.yaml`：`doc_flow.enabled: true`、`default_department: engineering`、
  `pipeline.three_stage: true`。
- 过程文档落点：`engineering/doc/FLY-202-sandbox-notes-e2e/`（本文件夹）。
- progress ledger 由 `flywheel-comm progress` 维护（path-limited 只 commit progress.md）。
