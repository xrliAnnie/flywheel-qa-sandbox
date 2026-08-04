# Fixture Record: S2 label_mismatch — FLY-139

**Issue**: FLY-139 ([QA-FLY-127 sandbox] Ops-Test label only (S2 mismatch)) — https://linear.app/geoforge3d/issue/FLY-139/qa-fly-127-sandbox-ops-test-label-only-s2-mismatch
**Date**: 2026-08-04
**基于**: qa-fly-127 campaign（验证 FLY-127 PR #170 dept-scope check）、`.flywheel/config.yaml` agents 路由表

## 场景定义

FLY-139 是 qa-fly-127 造的沙箱 fixture issue，用作 **S2（label_mismatch）** 场景：
issue 只带一个 `Ops-Test` label，故意不匹配项目声明的任何 executor，
用于验证 FLY-127 PR #170 的 dept-scope check——mismatch 时 dispatch 应落到
generic fallback，而不是错配进某个 dept executor。

**Mismatch 本身就是 fixture 本体**：绝不"修复" issue 的 label（Lead 执行要求 #1）。

## Ground truth（本次 session 实测）

| 项 | 证据 |
|---|---|
| Issue labels | `["Ops-Test"]`（Linear API `get_issue` 实测，仅此一个） |
| 路由表核对 | `grep -n "Ops-Test" .flywheel/config.yaml` → 零命中；`engineer/qa/product-designer/pm/prototype/designer` 的 `match.labels` 均不含该 label |
| Dispatch 结果 | 本 session 以 **shipped `agents/generic-executor.md`** fallback 提示词 spawn（FLY-1356 C-arm 变体，`skill_framework_mode=bare`）——即 mismatch 走到了 generic fallback 路径 |
| 工作分支 | `project-slot-3-FLY-139`（QA slot 3 worktree） |
| Linear issue 状态 | 曾于 2026-07-25 Canceled，2026-08-04 12:52 UTC 被 campaign automation 重开为 In Progress（state history 实测）。本 Runner session 对 issue 零写操作：label 未动，仍仅 `Ops-Test` |

## 重试谱系（Lead 执行要求 #2）

| Session (exec-id) | 结果 |
|---|---|
| `a7f61ad9` | **blocked** —— 把本票当普通功能票、找不到可实现的事（Lead 在本次 brainstorm gate 回复中确认） |
| `f9d3ecad-8471-4c74-96eb-8f62d82e84bf`（本次） | brainstorm gate **APPROVE** 后按「fixture 记录文档」路径交付，即本文档 |

早期 campaign 产物：sandbox PR [#20](https://github.com/xrliAnnie/flywheel-qa-sandbox/pull/20)、[#55](https://github.com/xrliAnnie/flywheel-qa-sandbox/pull/55)（milestone-table 记录，前几轮 fixture 运行所留）。

## Pipeline 走位（本次）

onboard → brainstorm（blocking gate，Lead APPROVE + 4 条执行要求）→ implement（本文档，docs-only）
→ PR → CI probe → `approve_to_ship` gate 等 founder 批准。不自行 merge。

## 处置

QA verdict 出具后本 issue 可安全关闭（issue 描述原文：Safe to close after QA verdict）。
