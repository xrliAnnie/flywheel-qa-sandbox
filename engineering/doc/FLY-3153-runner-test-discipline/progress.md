---
issue: FLY-3153
phase: implement
phaseCursor: 4/5
updated: 2026-10-03T13:13:51.469Z
nextStep: Open the PR, add the milestone as the final commit, freeze HEAD, then
  run exact-head CI
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
    status: done
  - id: green
    order: 3
    deps:
      - red
    done: model exports migrated and targeted verification passes
    status: done
  - id: review
    order: 4
    deps:
      - green
    done: effective code review approved
    status: done
  - id: handoff
    order: 5
    deps:
      - review
    done: PR opened and exact-head CI accepted
    status: doing
pointers: {}
---

# FLY-3153 progress
**phase**: implement (4/5)
**next**: Open the PR, add the milestone as the final commit, freeze HEAD, then run exact-head CI

## chunks
- ✅ audit — repository guidance and fixture dependency surface audited
- ✅ red — updated exact assertions fail against old model exports
- ✅ green — model exports migrated and targeted verification passes
- ✅ review — effective code review approved
- 🔨 handoff — PR opened and exact-head CI accepted
