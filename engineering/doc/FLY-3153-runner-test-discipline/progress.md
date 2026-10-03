---
issue: FLY-3153
phase: implement
phaseCursor: 3/5
updated: 2026-10-03T13:06:45.631Z
nextStep: Commit and push the verified migration, then request effective code review
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
    status: doing
  - id: handoff
    order: 5
    deps:
      - review
    done: PR opened and exact-head CI accepted
    status: todo
pointers: {}
---

# FLY-3153 progress
**phase**: implement (3/5)
**next**: Commit and push the verified migration, then request effective code review

## chunks
- ✅ audit — repository guidance and fixture dependency surface audited
- ✅ red — updated exact assertions fail against old model exports
- ✅ green — model exports migrated and targeted verification passes
- 🔨 review — effective code review approved
- ⬜ handoff — PR opened and exact-head CI accepted
