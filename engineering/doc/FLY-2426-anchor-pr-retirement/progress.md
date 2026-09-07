---
issue: FLY-2426
phase: implement
phaseCursor: 8/9
updated: 2026-09-07T20:11:35.353Z
nextStep: recheck FLY-2427 head, create literal-last milestone commit, push/open
  PR, then obtain exact-head review and complete needs_review
chunks:
  - id: onboard-and-reproduce
    order: 1
    deps: []
    done: Onboarded, acquired implement TURN, froze Lead criteria, and reproduced
      two cross-repository PR-number collisions from WAL-consistent production
      database copies.
    status: done
  - id: causal-research
    order: 2
    deps:
      - onboard-and-reproduce
    done: ""
    status: done
  - id: approved-plan
    order: 3
    deps:
      - causal-research
    done: ""
    status: done
  - id: tdd-anchor-selection
    order: 4
    deps:
      - approved-plan
    done: ""
    status: done
  - id: real-data-replay
    order: 5
    deps:
      - tdd-anchor-selection
    done: ""
    status: done
  - id: full-verification
    order: 6
    deps:
      - real-data-replay
    done: ""
    status: done
  - id: code-review
    order: 7
    deps:
      - full-verification
    done: ""
    status: done
  - id: merge-simulation
    order: 8
    deps:
      - code-review
    done: ""
    status: done
  - id: pr-and-milestone
    order: 9
    deps:
      - merge-simulation
    done: ""
    status: doing
pointers:
  plan: engineering/doc/FLY-2426-anchor-pr-retirement/plan.md
  exploration: engineering/doc/FLY-2426-anchor-pr-retirement/exploration.md
  research: engineering/doc/FLY-2426-anchor-pr-retirement/research.md
---

# FLY-2426 progress
**phase**: implement (8/9)
**next**: recheck FLY-2427 head, create literal-last milestone commit, push/open PR, then obtain exact-head review and complete needs_review

## chunks
- ✅ onboard-and-reproduce — Onboarded, acquired implement TURN, froze Lead criteria, and reproduced two cross-repository PR-number collisions from WAL-consistent production database copies.
- ✅ causal-research — 
- ✅ approved-plan — 
- ✅ tdd-anchor-selection — 
- ✅ real-data-replay — 
- ✅ full-verification — 
- ✅ code-review — 
- ✅ merge-simulation — 
- 🔨 pr-and-milestone — 
