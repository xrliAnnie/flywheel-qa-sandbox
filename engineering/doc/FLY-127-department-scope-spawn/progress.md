---
issue: FLY-127
phase: implement
title: department-scope-spawn
phaseCursor: 6/7
updated: 2026-08-30T11:23:51.491Z
nextStep: Create final milestone commit, push, and open PR
chunks:
  - id: baseline_audit
    order: 1
    deps: []
    done: Reproduced the omitted-leadId bypass and traced caller identity across the
      public start route, Gemini binding, QA injection, and Lead rules.
    status: done
  - id: route_identity_guard
    order: 2
    deps:
      - baseline_audit
    done: ""
    status: done
  - id: caller_binding
    order: 3
    deps:
      - route_identity_guard
    done: ""
    status: done
  - id: rules_acceptance
    order: 4
    deps:
      - caller_binding
    done: ""
    status: done
  - id: verification_review
    order: 5
    deps:
      - rules_acceptance
    done: ""
    status: done
  - id: pr_handoff
    order: 6
    deps:
      - verification_review
    done: ""
    status: doing
pointers:
  plan: engineering/doc/FLY-127-department-scope-spawn/plan.md
  exploration: engineering/doc/FLY-127-department-scope-spawn/exploration.md
  research: engineering/doc/FLY-127-department-scope-spawn/research.md
---

# FLY-127 progress — department-scope-spawn
**phase**: implement (6/7)
**next**: Create final milestone commit, push, and open PR

## chunks
- ✅ baseline_audit — Reproduced the omitted-leadId bypass and traced caller identity across the public start route, Gemini binding, QA injection, and Lead rules.
- ✅ route_identity_guard — 
- ✅ caller_binding — 
- ✅ rules_acceptance — 
- ✅ verification_review — 
- 🔨 pr_handoff — 
