# Design Review — FLY-1307 plan.md (Round 5)

Date: 2026-07-16
Author: Codex
Status: APPROVED

## Summary

Round 4 的两个遗留项均已完整闭合：external-merge 的 completed-recovery 旁路现已纳入唯一 authoritative seam 的 engine-owned 模式，attribution 审计与 kind-isolation 工作项也和真实源码一致。结合前四轮已收敛的 transition 原子性、engine ownership、v1 snapshot、materializer、USE-time ship gate、source-outbox hard gate 与 flag truth table，本 slicing plan 已达到可直接实施的标准。

## What's Good (Keep)

- terminal-caller 表现在按真实路径拆开 `external-merge-reconcile.handleParked` 与 `handleCompletedUnfinalized → finalize()`，如实记录后者当前直达 `runPostShipFinalization/markIssueDone` 的行为（`plan.md:144-159`）。
- completed-recovery 模式保留 legacy path-2 的三头相等 + trusted founder response 逻辑，并只对 `engine_owned` run 加做当前 authoritative head 上的完整 pinned `ship_claims` USE-time 复验；这既封住撤销/stale/missing claim，又避免对 completed row 重跑必然失败的 status-bound `verifyApproval`。
- path-2 测试组覆盖 claim 后撤销、stale head、missing claim、合法 claims 正向恢复及 legacy 快照，足以保护 fail-closed 与 byte-compat 两侧。
- research 现在准确说明：只有 allocate/transition mutation API 硬编码 `kind='dispatch'`；generic list、non-terminal reconcile 与三个 attribution ledger 子查询当前均未分 kind（`research.md:38-48,96-103`）。
- PR-7.5 已具名要求为 `listWorkflowRunAttributedFixRounds`、`isExecutionAttributedToWorkflowRun`、`hasWorkflowRunAttributedShipClaim` 增加 dispatch filter，并用 mixed-kind 测试证明 reconciler ownership 隔离且 `mat:` effect id 不会被当作 runner execution（`plan.md:250-259`）。
- staged immutable materialization evidence、receipt/ledger 三个同事务边界、current-output authority join、crash adoption 与并发 fence 仍保持完整；PR-7→PR-7.5→PR-8 依赖严格单向。
- flag 行为、legacy belt early-return、source-outbox 四层 hard gate、生产 flags 不翻转及 founder ship-gate enable 决策均与伞单 v1.35 和 Lead rulings 一致；未见 FLY-1306 或 §3.3 non-goal scope creep。

## Issues & Recommendations

1. **No blocking issues.** 实施时将 §2.2-7 的 closed caller table、§3 的 staged receipt 事务边界及 §4.1 的 flag truth table 直接作为 code-review checklist；新增 terminal writer 必须先回表并补逐 caller 反例测试。

## Verdict

APPROVED — ready to implement
