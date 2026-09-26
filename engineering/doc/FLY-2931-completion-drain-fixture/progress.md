---
issue: FLY-2931
phase: implement
phaseCursor: 2/5
updated: 2026-09-26T11:45:47.230Z
nextStep: Commit the fixture, push the branch, and open the PR
chunks:
  - id: fixture_file
    order: 1
    deps: []
    done: Exact one-line fixture exists and is byte-verified
    status: done
  - id: pr
    order: 2
    deps:
      - fixture_file
    done: Fixture committed, pushed, and PR opened
    status: doing
  - id: code_review
    order: 3
    deps:
      - pr
    done: Effective mandatory code review is APPROVED
    status: todo
  - id: long_verification
    order: 4
    deps:
      - code_review
    done: Required 300-second fixture verification completes
    status: todo
  - id: completion
    order: 5
    deps:
      - long_verification
    done: Lead mail handled and needs_review completion accepted
    status: todo
pointers: {}
---

# FLY-2931 progress
**phase**: implement (2/5)
**next**: Commit the fixture, push the branch, and open the PR

## chunks
- ✅ fixture_file — Exact one-line fixture exists and is byte-verified
- 🔨 pr — Fixture committed, pushed, and PR opened
- ⬜ code_review — Effective mandatory code review is APPROVED
- ⬜ long_verification — Required 300-second fixture verification completes
- ⬜ completion — Lead mail handled and needs_review completion accepted
