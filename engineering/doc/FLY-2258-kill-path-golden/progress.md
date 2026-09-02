---
issue: FLY-2258
phase: implement
phaseCursor: 7/8
updated: 2026-09-02T07:10:55.112Z
nextStep: Push branch, open PR, add literal-last milestone, and await exact-head CI
chunks:
  - id: onboard
    order: 1
    deps: []
    done: Repository contract, onboarding materials, clean base, inbox, and TURN
      verified
    status: done
  - id: red-baseline
    order: 2
    deps:
      - onboard
    done: Existing inventory test proved the 556-versus-552 mismatch and exact
      four-entry delta
    status: done
  - id: design-docs
    order: 3
    deps:
      - red-baseline
    done: ""
    status: done
  - id: design-review
    order: 4
    deps:
      - design-docs
    done: ""
    status: done
  - id: fixture-update
    order: 5
    deps:
      - design-review
    done: ""
    status: done
  - id: verification
    order: 6
    deps:
      - fixture-update
    done: ""
    status: doing
  - id: code-review
    order: 7
    deps:
      - verification
    done: ""
    status: done
  - id: pr-handoff
    order: 8
    deps:
      - code-review
    done: ""
    status: doing
pointers:
  plan: engineering/doc/FLY-2258-kill-path-golden/plan.md
  exploration: engineering/doc/FLY-2258-kill-path-golden/exploration.md
  research: engineering/doc/FLY-2258-kill-path-golden/research.md
---

# FLY-2258 progress
**phase**: implement (7/8)
**next**: Push branch, open PR, add literal-last milestone, and await exact-head CI

## chunks
- ✅ onboard — Repository contract, onboarding materials, clean base, inbox, and TURN verified
- ✅ red-baseline — Existing inventory test proved the 556-versus-552 mismatch and exact four-entry delta
- ✅ design-docs —
- ✅ design-review —
- ✅ fixture-update —
- 🔨 verification —
- ✅ code-review —
- 🔨 pr-handoff —
