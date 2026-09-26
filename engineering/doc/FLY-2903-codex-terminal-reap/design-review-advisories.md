# FLY-2903 已结束的 Codex 体真正关掉 — 设计评审建议（实现必做）
Issue: FLY-2903 (https://linear.app/geoforge3d/issue/FLY-2903/codex收尸-已结束的-codex-runner-必须真正关掉daemon-app-server-关闭可验证goal-runtime)
日期: 2026-09-26
基于: plan.md

## 评审结论

- R1：request `c213b7f3-85f7-4d8c-9fdd-bf4a76abb85d`（gate `8d4d98d2`），CHANGES_REQUESTED（1 HIGH + 3 MEDIUM + 6 LOW），全部采纳，处置见 plan §12。
- R2：request `4968051f-c96b-45b3-aafc-8b7c3055ebff`（gate `5cd0b7f8`，manifest revision 2），**APPROVED**。批准绑定 plan blob `179d65cb272e39193f75ba1a95c6a10e669f86fd`（commit `f44401884`）。Bridge `design_review_approval_proof` coordinator 行 `approved`（2026-09-26T00:05:54.535Z）。
- 通道：Bridge 同族评审（`review_same_family_allowed=1`，本 run 节点都派在 Opus 上，评审是独立的 Claude 进程，不是自审）。Lead 在问题 `4ff335ad` 中确认走这条通道，不补本地 `/codex-design-review`。因为没有 Codex 线程，所以不写本地 `design-review.json`（写了就是伪造 `codexThreadId`）。

## R2 建议（策略 `medium_low_findings_are_non_blocking_v1`，不阻断批准）

plan.md 保持为已批准的 blob，不再修改（改了就要重新评审）。下列 7 条**由实现节点照做**，它们都只收窄或修正 plan，不扩大范围。与 plan 冲突时以本文件为准。

| # | findingKey | 级别 | 实现时必须这样做 |
|---|------------|------|----------------|
| A1 | restart-predicate-lease-undefined | MEDIUM | §3.2 重启谓词写成 `() => (lease?.stopRequested ?? null) === null && !(ctx.processLifecycle?.retirementApproved?.() ?? false)`；或者只在 lease 存在时才注入谓词。补一条用例：「未注入 registry + transport death → 仍然重启」（adapter 层保持「谓词未注入 → allowed」的兼容承诺） |
| A2 | probe-order-unknown-before-alive | LOW | §6.2 判定顺序改为 **active → alive → procs unknown → unverifiable_process → closed → unknown**。快照瞬态不影响收一个身份已证实的活 daemon，快照只影响 `closed` 结论 |
| A3 | rollout-root-hardcoded | LOW | §6.4「位于 codex-homes 之下」改用包根导出的 `codexHomesRoot(env)`（读 `FLYWHEEL_CODEX_HOMES_ROOT`），不写死 `~/.flywheel/codex-homes*`，让 QA 台架与 529 房的隔离根也能测到「token 涨 → 告警」 |
| A4 | closed-excludes-no-group-ledger | LOW | §6.2 `closed` 的第二个析取改为 `ledger ∈ {missing, no_group} ∧ !socketLive`（仍要求 `procs.length === 0`）；补 `no_group` 形状用例（daemon 从未 spawn 的失败执行体两 tick 后落 closed） |
| A5 | evidence-fields-stale | LOW | §5.1 `last_evidence` 的字段白名单同步为 `{source, ownerStop, reap, liveness, ledger, socketLive, groupState, procs:{status,count}, ownership}` |
| A6 | reserved-fence-flag-gating | LOW | §7.3 明确：reserved 围栏的 `requestStop` **不受** `codex_terminal_reap_enabled` 控制（纯内存标记、不发信号）。flag 只控制巡检里的 active 请停与 reap |
| A7 | retirement-tick-serial-wait | LOW | `requestStop` 的等待上限按 reason 区分：`process_retirement` 用 **8s**（它串行跑在 `runWorkflowProcessRetirementTick` 里），`terminate` / `close_runner` / `close_tmux` 用 25s，`terminal_sweep` 用 5s |
