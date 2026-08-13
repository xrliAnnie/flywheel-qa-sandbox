# FLY-1718 re-dispatch 重生对账 — Code review R1

Issue: FLY-1718 (https://linear.app/geoforge3d/issue/FLY-1718/re-dispatch-丢已拍板成果-fresh-start-无视-origin-同名分支open-pr从-main-另起分叉1704)
日期: 2026-08-12
基于: plan.md

## 结论

`CHANGES_REQUESTED`。2 个 HIGH 阻断项均位于 P4 DOA enforcement;另有 6 个 MEDIUM、2 个 LOW advisory。实施选择全部修复,不只处理阻断项。

## Findings 与处置

| 严重度 | findingKey | 处置 |
|---|---|---|
| HIGH | `doa-lane-gate-ignores-admission-exemptions` | 新增 durable participant identity;只有取得 reservation 的 execution 被下游 fence |
| HIGH | `doa-kill-switch-not-honored-at-enforcement-points` | kill switch 贯穿 verify/activate/close,关闭时保留 ledger 且不 enforcement |
| MEDIUM | `abort-prelaunch-deletes-foreign-inflight-entry` | Map 删除增加 executionId ownership compare |
| MEDIUM | `bridge-runs-git-status-in-runner-controlled-worktree` | 改用禁 filters 的 Git plumbing 三方 blob 对账 |
| MEDIUM | `worktree-hookspath-replaces-project-hooks` | per-worktree wrapper 组合并链回原 hooks |
| MEDIUM | `continuity-startpoint-flips-three-stage-takeover` | continuity metadata 排除 design retry takeover predicate |
| MEDIUM | `needs-lead-cleared-without-audited-reset` | needs_lead 提前 fail-closed,只允许 audited reset 清除 |
| MEDIUM | `resume-refs-resolved-independently` | 每次 resume 尝试固定单一 ref,完整 snapshot 不跨 ref 拼接 |
| LOW | `force-push-contract-ignores-push-guard-killswitch` | prompt contract 与 guard kill switch 同门 |
| LOW | `dirty-check-compares-head-not-session-branch` | HEAD 必须与 persisted session branch tip 相等 |

修复 commit: `34b9ee9d`。新 head 必须重新发起独立 code review gate,不得复用本轮拒绝结果。
