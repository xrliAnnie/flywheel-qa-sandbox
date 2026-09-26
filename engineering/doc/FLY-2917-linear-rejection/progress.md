---
issue: FLY-2917
phase: implement
phaseCursor: 3/3
updated: 2026-09-26T06:52:15.422Z
nextStep: 243 targeted tests and affected build pass; push final milestone head,
  obtain code review, then needs_review handoff
chunks:
  - id: audit_plan
    order: 1
    deps: []
    done: Onboarded, TURN acquired; source and pinned SDK show orphaned lazy getter
      promises. Design review pending.
    status: done
  - id: causal_fix
    order: 2
    deps:
      - audit_plan
    done: ""
    status: done
  - id: process_guard
    order: 3
    deps:
      - causal_fix
    done: ""
    status: done
  - id: verification
    order: 4
    deps:
      - process_guard
    done: ""
    status: done
  - id: review_handoff
    order: 5
    deps:
      - verification
    done: ""
    status: doing
pointers:
  plan: engineering/doc/FLY-2917-linear-rejection/plan.md
---

# FLY-2917 progress
**phase**: implement (3/3)
**next**: 243 targeted tests and affected build pass; push final milestone head, obtain code review, then needs_review handoff

## chunks
- ✅ audit_plan — Onboarded, TURN acquired; source and pinned SDK show orphaned lazy getter promises. Design review pending.
- ✅ causal_fix — 
- ✅ process_guard — 
- ✅ verification — 
- 🔨 review_handoff — 
