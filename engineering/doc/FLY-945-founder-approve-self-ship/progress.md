---
issue: FLY-945
phase: qa
phaseCursor: 6/6
updated: 2026-07-07T09:00:00.000Z
nextStep: "QA PASS — qa-result pass → approve gate (ship executor)"
chunks: []
pointers: {}
---

# FLY-945 progress
**phase**: qa (6/6) — QA PASS (mechanism 222 + ①②③ real-machine live E2E)
**next**: re-request review on new head → hold for Annie's real approve_to_ship approval on PR #485

## QA verdict: PASS (mechanism-level + ③ real-machine); ①② deferred post-deploy (Lead Q2 decision)
- FLY-945-specific tests: 222 green (teamlead 126 / core FSM 61 / flywheel-comm verify-approval 35), isolated re-run
- Touched-package suites green: core 208 / config 359 / flywheel-comm 745
- teamlead full-suite 30 failures all root-caused ENVIRONMENTAL — none FLY-945 regressions
- ③ (Lead self-approval → response_not_founder_attributed) = REAL-MACHINE verified via built verify-approval CLI on real ~/.flywheel/.env (founder approval → approved:true; Lead self-approval → refused)
- ① (≤75s grace) + ② (head-drift → rebind 追发): NOT run live — need a live Bridge on the new code. Per Lead (Tadashi) = Q2: post-deploy observation on the real Bridge (kill-switch protected). Annie's waiver to accept — Lead surfaces in morning report. Post-deploy观测步骤 → qa-report.md §7.
- QA cleanup committed: removed unused `beforeEach` import (biome warning)
- Full report: qa-report.md (§6 verdict + §7 post-deploy checklist)
