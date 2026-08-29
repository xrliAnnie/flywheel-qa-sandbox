# Design Review — FLY-1189 plan.md (Round 3)

Date: 2026-07-11
Author: Codex
Status: CHANGES REQUESTED

## Summary

Round 3 已闭合 Round 2 的 7 个原 finding：pre-boot config seam、专用 S7 target、driver-owned trap、slot 内 quarantine、borrowed-lock finalize、branch-aware S9/C2' 与 WAL-aware taint 查询都已成为可实施合同。当前只剩一个真实并发时序缺口：S7 把 CLEARING log 设为必需中间态证据，但 production reconcile 可以在 close-runner 的 completed transition 与 CLEARING mark 之间先把该行 RESOLVED；这个合法收口会被当前矩阵误判为 FAIL。把 S7 改成接受并区分两种真实 interleaving 后即可批准。

## What's Good (Keep)

- `--detection-lead-grace-ms` 放在 test-deploy 生成 canonical YAML 的唯一 pre-boot 点，且缺省 byte-identical；Phase D 现在真正可执行。
- borrowed slots 在 Bridge PID 出现后全部 finalize，并带 owner/campaign sidecar；超过 300 秒不再被 stale-claim 逻辑误回收，borrowed-slot teardown 也 fail-loud 指向 owner。
- driver 在 mutation 前持有跨场景 trap，injector 只做幂等 journaled 原子操作；这修复了一次性子进程无法持有 EXIT trap 的根本问题。
- quarantine 回到 `${SLOT_DIR}` 安全根，restore 又锁定 journaled source→destination 单向关系，路径锚与恢复合同一致。
- S6 的 C2' 已具名并写明 trigger/kind/owner/grace 时点；S9 也正确区分 unified-c 与 detection_suspicious 两种持久化面。
- S11 对 JSON 用文本扫描、对 SQLite/WAL 用 readonly structured queries，并把 DB/query failure 设为 fail-closed；action-journal invariant 同时覆盖“误发 signal 但未写 DB”的伤害面。
- TTL rebound 的不可达性被诚实降为单测 spot-check + qa-report finding，没有通过 DB tampering 冒充 E2E。

## Issues & Recommendations

1. **S7 仍把一种合法并发 interleaving 判成 FAIL。** `close-runner(done:true)` 先同步把 session transition 到 `completed`（`close-runner.ts:158-207`），随后在真正标 CLEARING 前会经过多个异步点：`killCmuxLinkedSession`、`killTmuxWindow`、`closeRunnerTerminalView`（`:252-343`），最后才调用 `markDetectionClearingSafe`（`:373-416`）。与此同时 GatePoller 每约 60 秒 fire-and-forget 跑 detection reconcile（`gate-poller.ts:564-583`），而 reconcile 的第一步就是同步 recovery auto-RESOLVE（`detection-reconcile-tick.ts:84-106`）。因此 tick 若落在上述 await 窗口，ACKED 行会先变 RESOLVED；后续 CLEARING update 因只接受 NEW/LEAD_NOTIFIED/ACKED 而改 0 行，也不会出现 `detection episode(s) marked CLEARING` log。最终状态和“不刷屏”语义都正确，但 plan `:148` 当前要求 close success **且必须有该 log**，会产生假 FAIL。

   **建议修复：**把 S7 写成 branch-aware 的真实 interleaving 断言：

   - Branch A（CLEARING wins）：close response success + `marked CLEARING` log，随后 DB `RESOLVED/resolved_via=recovery`，期间零新通知。
   - Branch B（recovery wins before mark）：close response success；没有 CLEARING log，但同一精确 episode 在 close request/response 窗口内直接变 `RESOLVED/resolved_via=recovery`，且零新通知；记录为 `recovery_preempted_clearing`，不是 FAIL。

   若 E2E 必须强制观察 Branch A，则 driver 需先锚定一次刚完成的 reconcile 再立即执行 T7，给下个 tick 留出完整 cadence，并仍为 Branch B 保留非假失败兜底。C5 的 CLEARING transition 本身继续由现有单测 spot-check 证明；真机的硬目标应是 close 后可靠收口且无重复通知，而不是依赖不可原子观察的中间状态一定胜过并发 recovery。

## Verdict

CHANGES REQUESTED — address item above
