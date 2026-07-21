---
issue: FLY-1385
phase: implement
phaseCursor: 4/5
updated: 2026-07-21T19:13:31.000Z
nextStep: "commit+push the two MEDIUM fixes, then request incremental code review
  and targeted QA re-test on the exact final head"
chunks: []
pointers: {}
---

# FLY-1385 progress
**phase**: implement (4/5)
**next**: commit+push the two MEDIUM fixes, then request incremental code review and targeted QA re-test on the exact final head

- 3/5: 两项 MEDIUM 已按 TDD 红→绿：`tmux_output` 只记 diagnostic log，dispatcher 与 StateStore 两层都禁止 severe page；watch 在 run 非 active 时立即删除，否则 24h TTL 删除，prune 每 tick 最多 200 条并先于 probe。相关三文件 61/61 通过。
- 4/5: targeted Biome、diff check、teamlead typecheck、相关 61/61 与全仓 `pnpm -r build` 通过；全仓 lint 仍仅被工作区运行态 `.flywheel/*` 和本地 `.pnpm-store/*` 的既有 640 项格式噪声阻断。
