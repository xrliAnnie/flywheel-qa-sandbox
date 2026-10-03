---
issue: FLY-3153
phase: implement
phaseCursor: 1/5
updated: 2026-10-03T12:59:39.216Z
nextStep: Update exact assertions and capture failing targeted tests
chunks:
  - id: audit
    order: 1
    deps: []
    done: repository guidance and fixture dependency surface audited
    status: done
  - id: red
    order: 2
    deps:
      - audit
    done: updated exact assertions fail against old model exports
    status: todo
  - id: green
    order: 3
    deps:
      - red
    done: model exports migrated and targeted verification passes
    status: todo
  - id: review
    order: 4
    deps:
      - green
    done: effective code review approved
    status: todo
  - id: handoff
    order: 5
    deps:
      - review
    done: PR opened and exact-head CI accepted
    status: todo
pointers: {}
---

# FLY-3153 progress
**phase**: implement (1/5)
**next**: Update exact assertions and capture failing targeted tests

## chunks
- ✅ audit — repository guidance and fixture dependency surface audited
- ⬜ red — updated exact assertions fail against old model exports
- ⬜ green — model exports migrated and targeted verification passes
- ⬜ review — effective code review approved
- ⬜ handoff — PR opened and exact-head CI accepted
