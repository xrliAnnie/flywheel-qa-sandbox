# FLY-1571 park 与待处理信号优先级 — 设计修正
Issue: FLY-1571 (https://linear.app/geoforge3d/issue/FLY-1571/消息层重构-b-批次1-runner-stop-通知带停的原因)
日期: 2026-08-04
基于: plan.md + QA FAIL-1(head debc9784) + Lead 修令 50861669-360f-42a9-97a2-588b659afcc1

## 裁定

本文件是 `plan.md` §5 的增量修正。原 plan 保留为冻结的设计与评审记录,不静默改写;
两者冲突时,仅以下 park 优先级修正以本文件为准。

active park 不再无条件映射为 `done`。在得出 park 的 `done` 结论前,必须先查询
本轮相关的未答 pending 信号:

1. 有未答 checkpoint question → `awaiting_approval`;
2. 否则有未答普通 question → `blocked`;
3. 两者都没有 → `done`,detail 仍为 `parked: <park reason>`。

## QA verdict 关键段(逐字)

> QA verdict FAIL(head debc9784):park 抢在 pending-gate 之前,等审批被报成 done(runner-stopped.ts:491-502,plan 5 优先级 3 的映射本身写错,实现忠实照做)。

> 修法(QA 建议,我已裁定采纳):park 的 done 结论改为先查优先级 4/5 的 pending 信号 —— 有未答 checkpoint → awaiting_approval;有未答普通 ask → blocked;都没有才 done。

## 废除的概念

- `runner_declared_states` 有 active park 时,不检查 pending question 就无条件报告
  `reason=done`。
- 原 plan §5 表中「park 位于 pending checkpoint / 普通 ask 之前」这一局部顺序。

## 保留的器官

- 其余 reason 优先级链全部保留:结构化 StopFailure、complete 面包屑、session
  terminal status、Codex quota/context 尾部识别与最终 blocked 兜底均不变。
- 三个触发点全部保留:Claude `Stop`、Claude `StopFailure`、Codex
  `notify + turn-ended`。
- pending 查询的本轮边界、checkpoint 优先普通 ask、report 排除、幂等键与既有
  `flywheel-comm` 上行通道全部保留。
- park 在没有未答 pending 信号时仍报告 `done`,detail 形状不变。

## 增量验收

- active park + 未答 `approve_to_ship` → `awaiting_approval`,detail 指向该 gate。
- active park + 未答普通 ask → `blocked`,detail 指向该 question。
- active park + 无未答 pending → `done`,detail 仍为原 park reason。
- 原 §5 其余 reason 矩阵继续全绿。
