---
issue: FLY-1338
phase: qa
phaseCursor: 5/5
updated: 2026-07-18T20:40:00.000Z
nextStep: Lead ruling needed on the codex_review_record for the QA head — see qa-report.md §6b and the open ask
chunks: []
pointers: {}
---

# FLY-1338 progress

**phase**: qa (5/5) — verification complete, verdict PASS (qa-result emitted)

**state**:
- CI green 9/9 on head `343770e11` lineage (last full-green probe: `452c383d6`, exit 0 incl. `CI OK`).
- Acceptance evidence in `qa-report.md`: wall clock 18m09s → 5m17s (-71%); coverage 1000 → 1000
  test files with per-package parity; teamlead 615 → 205×3.
- QA added `scripts/__tests__/ci-matrix-coverage.test.sh` (wired into script-tests).
  Its own first revision had two false-green paths, found by Codex review via fault
  injection and fixed; Codex round 4 = APPROVED. See `qa-report.md` §6b.

**blocked on (not a QA failure)**: the Codex sandbox cannot reach `api.github.com`, so no
`codex_review_record` was written for the QA head. `verify-approval` would refuse, so the
approve gate has deliberately NOT been opened — opening it would burn a founder approval on
a head that cannot bind. Lead was asked to choose: (a) Lead records it, (b) Lead authorizes
this session to record it, or (c) the implement-phase session earns it. This session did not
self-certify: the code under review is its own commits.

**next**: act on the Lead ruling → then CI precondition probe → approve gate → hold for founder.
