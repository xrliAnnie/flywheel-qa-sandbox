---
issue: FLY-2238
phase: implement
phaseCursor: 7/7
updated: 2026-09-01T23:59:48.072Z
nextStep: Update milestone as literal last commit, push PR, and prove CI green
chunks:
  - id: docs-and-design
    order: 1
    deps: []
    done: ""
    status: done
  - id: builtin-tdd
    order: 2
    deps:
      - docs-and-design
    done: ""
    status: done
  - id: resolver-config-tdd
    order: 3
    deps:
      - builtin-tdd
    done: ""
    status: done
  - id: template-publication
    order: 4
    deps:
      - resolver-config-tdd
    done: ""
    status: done
  - id: full-verification
    order: 5
    deps:
      - template-publication
    done: ""
    status: done
  - id: code-review
    order: 6
    deps:
      - full-verification
    done: ""
    status: done
  - id: pr-handoff
    order: 7
    deps:
      - code-review
    done: ""
    status: doing
pointers:
  plan: engineering/doc/FLY-2238-fable-51-single-knob/plan.md
  exploration: engineering/doc/FLY-2238-fable-51-single-knob/exploration.md
  research: engineering/doc/FLY-2238-fable-51-single-knob/research.md
---

# FLY-2238 progress
**phase**: implement (7/7)
**next**: Update milestone as literal last commit, push PR, and prove CI green

## chunks
- ✅ docs-and-design —
- ✅ builtin-tdd —
- ✅ resolver-config-tdd —
- ✅ template-publication —
- ✅ full-verification —
- ✅ code-review —
- 🔨 pr-handoff —
