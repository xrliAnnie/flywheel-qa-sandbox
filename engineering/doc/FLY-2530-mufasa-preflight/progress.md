---
issue: FLY-2530
phase: implement
phaseCursor: 3/5
updated: 2026-09-13T23:02:38.622Z
nextStep: "PR1172 advisory1 test-only fix: InfraBot19/19; Mufasa unchanged2/6;
  fresh review/CI required; authority-home check deferred"
chunks:
  - id: design-handoff
    order: 1
    deps: []
    done: "Lead ruling d281fb3a-bad3-4802-9727-c688a6738b19: option 1 approved; full
      DOC-FLOW/design review waived. Plan: remove --lead in both Mufasa and
      infra-bot TUI launcher preflights, preserve offline cutover guard;
      simulate own launchd job and verify both wrappers reach stub runtime,
      retain active-process/failure guards; full gates, review, PR,
      needs_review. No production restart/deploy."
    status: done
  - id: tdd
    order: 2
    deps:
      - design-handoff
    done: ""
    status: done
  - id: verification
    order: 3
    deps:
      - tdd
    done: ""
    status: done
  - id: review-pr
    order: 4
    deps:
      - verification
    done: ""
    status: doing
  - id: handoff
    order: 5
    deps:
      - review-pr
    done: ""
    status: todo
pointers:
  pr: https://github.com/xrliAnnie/flywheel/pull/1172
---

# FLY-2530 progress
**phase**: implement (3/5)
**next**: PR1172 advisory1 test-only fix: InfraBot19/19; Mufasa unchanged2/6; fresh review/CI required; authority-home check deferred

## chunks
- ✅ design-handoff — Lead ruling d281fb3a-bad3-4802-9727-c688a6738b19: option 1 approved; full DOC-FLOW/design review waived. Plan: remove --lead in both Mufasa and infra-bot TUI launcher preflights, preserve offline cutover guard; simulate own launchd job and verify both wrappers reach stub runtime, retain active-process/failure guards; full gates, review, PR, needs_review. No production restart/deploy.
- ✅ tdd — 
- ✅ verification — 
- 🔨 review-pr — 
- ⬜ handoff — 
