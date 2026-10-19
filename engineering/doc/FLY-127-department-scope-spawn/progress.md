---
issue: FLY-127
phase: implement
title: department-scope-spawn
phaseCursor: 7/7
updated: 2026-08-30T12:33:17Z
nextStep: Await DAG-orchestrated QA retest
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
    done: Focused FLY-127 suites, Linux CI, and fresh cross-family code review passed
      on rework head 83b7df5f.
    status: done
  - id: pr_handoff
    order: 6
    deps:
      - verification_review
    done: PR 161 is updated with the rework and independent verification evidence.
    status: done
pointers:
  plan: engineering/doc/FLY-127-department-scope-spawn/plan.md
  exploration: engineering/doc/FLY-127-department-scope-spawn/exploration.md
  research: engineering/doc/FLY-127-department-scope-spawn/research.md
---

# FLY-127 progress — department-scope-spawn
**phase**: implement (7/7)
**next**: Await DAG-orchestrated QA retest

## chunks
- ✅ baseline_audit — Reproduced the omitted-leadId bypass and traced caller identity across the public start route, Gemini binding, QA injection, and Lead rules.
- ✅ route_identity_guard — 
- ✅ caller_binding — 
- ✅ rules_acceptance — 
- ✅ verification_review — Focused FLY-127 suites, Linux CI, and fresh cross-family code review passed on rework head 83b7df5f.
- ✅ pr_handoff — PR 161 is updated with the rework and independent verification evidence.
