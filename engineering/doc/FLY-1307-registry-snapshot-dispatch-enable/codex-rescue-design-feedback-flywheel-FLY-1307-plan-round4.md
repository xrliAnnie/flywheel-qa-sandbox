# Design Review — FLY-1307 plan.md (Round 4)

Date: 2026-07-16
Author: Codex
Status: CHANGES REQUESTED

## Summary

Round 3 的 staged materialization evidence 与 reconciler ownership 已基本闭合，三条 housekeeping exemption 也与真实源码职责吻合。当前仍有一个 HIGH：所谓 closed terminal-caller table 把 external-merge 合并成单一路径，遗漏了真实存在且会直接触发 Linear Done 的 completed-recovery 分支；另有一条 research 对当前 attribution SQL 的描述仍不准确。

## What's Good (Keep)

- `workflow_materialization_receipt` 现在有明确的 `(effect_id, stage)` append-only 行、stage 闭集、唯一键与逐阶段必填证据，不再要求同一不可变行在 intent 后补写 commit/push 数据（`plan.md:227-240`）。
- allocate、adopt、push-confirm 三个 ledger/receipt 同事务边界正确消除了两类半写态；push-before-DB、restart-at-intent 与 restart-at-launch_committed 也都有可重放的 durable source（`plan.md:234-247`）。
- `MaterializedHeadAuthority` 只接受 push-confirmed evidence，并复核 `workflow_node_output_current` 的当前 attempt/output；旧物化 head 不会在 rematerialization 后继续成为 review/founder authority。
- dispatch/materialize reconciler ownership 已在 plan 中明确分 kind，混合行回归测试也被列为 PR-7.5 前置项（`plan.md:248-255`）。
- `closeRunnerInner`、`reconcileDoneRunning`、`finalizeStaleBlocker` 被明确归为 session housekeeping，而不是 workflow ship terminal；源码核对显示这些路径不直接调用 `runPostShipFinalization`/`markIssueDone`，逐 caller 断言 workflow run 与 Linear Done 不动是合适的边界。
- flag 真值表、engine ownership、decision canonicalization、v1 snapshot、TURN source hard gate、ship-claim exact predicate mapping、PR-7→7.5→8 顺序及生产 flags 不翻转均保持了前轮已批准方向；未发现新增 scope creep。

## Issues & Recommendations

1. **[HIGH] “封闭 caller 表”仍漏掉 external-merge 的 completed-recovery ship 路径；该路径当前绕过 composite seam 后直接触发 Linear Done。** 表中把 `external-merge` 放在“`computeAuthoritativeShipDecision` 既有调用方”一行（`plan.md:144-170`），但真实模块有两条不同路径：`handleParked` 的确在 `external-merge-reconcile.ts:291-331` 调用该 seam；`handleCompletedUnfinalized` 则只做 bound/authoritative/headRef 三头相等 + trusted founder response 检查，随后在 `:334-361` 直接调用 `finalize()`，而 `finalize()` 在 `:253-274` 直接进入 `runPostShipFinalization` 并传入 `markIssueDone`。这正是表自身规则所说的“表外 terminal write point”。而且不能机械地在 completed row 上调用现有 legacy seam：`computeAuthoritativeShipDecision` 最终复用 `verifyApproval`，后者硬要求 session 仍为 `approved_to_ship`（`verify-approval.ts:466-472`），所以 completed recovery 会恒拒；如何保持 legacy path-2 字节兼容、同时在 Done USE-time 重验 engine-owned ship claims，仍被留给实现者决定。**建议修复：** 将 `external-merge-reconcile.handleParked` 与 `handleCompletedUnfinalized`/`finalize` 拆成实际 symbol 行；在同一个 authoritative composite seam 中钉死一个 engine-owned completed-recovery mode：保留现有 legacy path-2 的 headMatch + trusted approval 判定原样，再对 engine-owned run 以当前 authoritative head 重验完整 ship_claims，缺失/revoked/conflict/stale ⇒ 不调用 post-ship/Done。不要对 completed row 重跑 status-bound `verifyApproval`。增加三组 path-2 反例：engine-owned claim 后撤销、head stale、claim 缺失均不 Done/不归档；合法当前 claims 才能恢复；legacy completed-recovery 快照字节不变。

2. **[MEDIUM] research 仍把当前 attribution 查询误写成已经 hardcode `kind='dispatch'`。** `research.md:38-46,94-100` 写“mutation/attribution 主路径按/硬编码 `kind='dispatch'`”；当前只有 allocate/transition mutation SQL 硬编码 dispatch。三个真实 attribution 入口——`listWorkflowRunAttributedFixRounds`、`isExecutionAttributedToWorkflowRun`、`hasWorkflowRunAttributedShipClaim`——对子查询 `workflow_side_effect_ledger` 都只有 `run_id`/`execution_id` 条件，没有 kind 条件（`StateStore.ts:16100-16162`）。plan 已正确要求 PR-7.5 给 attribution 子查询补 filter，因此这是 audit prose 与其实施项相互矛盾，而非新设计问题。**建议修复：** research 改为“mutation API 硬编码 dispatch；generic list、non-terminal reconcile query 以及 attribution subqueries 当前都未按 kind 隔离”；plan §3 具名列出上述三个 attribution 方法，mixed-kind 回归同时证明 attribution 不再把 `mat:` effect id 当 runner execution。

## Verdict

CHANGES REQUESTED — address items above
