---
issue: FLY-2096
phase: implement
phaseCursor: 7/7
updated: 2026-09-03T22:55:28.687Z
nextStep: "QA node: independent verification complete; ship report + qa-result
  pending on this head's CI"
chunks:
  - id: m1a-positive-control
    order: 1
    deps: []
    done: main 7/7 green
    status: done
  - id: m1b-liveness-gate
    order: 2
    deps: []
    done: alive stays silent; absent alerts without holding
    status: done
  - id: m1c-old-tree-evidence
    order: 3
    deps: []
    done: 069013b25^ gives 2 expected failures and 5 skips
    status: done
  - id: m2-include-deferred
    order: 4
    deps: []
    done: dead bypass removed; consumer sweep is empty
    status: done
  - id: m3-attempt-settle-red
    order: 5
    deps: []
    done: live=true openEpisodes=1 alerts=1 settlement=null
    status: done
  - id: m3-attempt-settle-green
    order: 6
    deps: []
    done: both completion paths settle; legacy no-attempt path remains compatible
    status: done
  - id: m4-docs-and-fly2241-note
    order: 7
    deps: []
    done: production and manual-recovery boundaries recorded without data mutation
    status: done
pointers:
  plan: engineering/doc/FLY-2096-rework-stall-hold/plan.md
  exploration: engineering/doc/FLY-2096-rework-stall-hold/exploration.md
  research: engineering/doc/FLY-2096-rework-stall-hold/research.md
  reviewedSha: c8210e14531f3f368e8b88d10ec4ad6c187f2697
handoff: "Independent QA (exec e7787c04): old-tree positive control reproduced
  at 069013b25^ (2 reds: held / engine_run_not_active, 5 skipped); mutation
  checks on both settle call sites each turn the suite red; includeDeferred
  sweep 0 hits across repo + plugin fork worktree (6895 files) + plugin caches
  (21614 files); real Discord 529 alert-channel E2E (isolated) shows PRE-FIX
  ghost alert vs POST-FIX silence with a same-pass live control."
---

# FLY-2096 progress
**phase**: implement (7/7)
**next**: QA node: independent verification complete; ship report + qa-result pending on this head's CI

## chunks
- ✅ m1a-positive-control — main 7/7 green
- ✅ m1b-liveness-gate — alive stays silent; absent alerts without holding
- ✅ m1c-old-tree-evidence — 069013b25^ gives 2 expected failures and 5 skips
- ✅ m2-include-deferred — dead bypass removed; consumer sweep is empty
- ✅ m3-attempt-settle-red — live=true openEpisodes=1 alerts=1 settlement=null
- ✅ m3-attempt-settle-green — both completion paths settle; legacy no-attempt path remains compatible
- ✅ m4-docs-and-fly2241-note — production and manual-recovery boundaries recorded without data mutation

**handoff**: Independent QA (exec e7787c04): old-tree positive control reproduced at 069013b25^ (2 reds: held / engine_run_not_active, 5 skipped); mutation checks on both settle call sites each turn the suite red; includeDeferred sweep 0 hits across repo + plugin fork worktree (6895 files) + plugin caches (21614 files); real Discord 529 alert-channel E2E (isolated) shows PRE-FIX ghost alert vs POST-FIX silence with a same-pass live control.
