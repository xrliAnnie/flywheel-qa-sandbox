---
issue: FLY-1645
phase: design
phaseCursor: 6/6
updated: 2026-08-11T18:42:00.060Z
nextStep: "QA COMPLETE, verdict = PASS, but qa-result submission is BLOCKED at
  the engine layer: POST /api/workflow/decision -> HTTP 409 transition_refused
  (deterministic, CLI retried 4x). Three-layer read-only diagnosis done: binding
  replay returns 1 (layer 1 excluded), request did reach the server (layer 2
  excluded), run is healthy (status=active, current_node=qa, my node running,
  engine_owned=1) and the manifest HAS the qa_pass edge, credential
  valid+unconsumed+unexpired, workflow_claims for my exec = 0 rows (verdict NOT
  recorded). Escalated to Lead with the full replay; not retrying, not touching
  the credential. Full 2921-char verdict preserved in
  ~/.flywheel/state/qa-result-failed/<exec>.json. Ship report hosted OK
  (https://fw-reports-a53de2.vercel.app/r/a877490b49754c747850d588a226f667/,
  HTTP 200) but Discord delivery 404 issue_thread_not_found - handed to Lead for
  manual delivery. PR #808 is OPEN with head 82aa2687 == verified head. 529 room
  left running for possible re-verification."
chunks: []
pointers: {}
---

# FLY-1645 progress
**phase**: design (6/6)
**next**: QA COMPLETE, verdict = PASS, but qa-result submission is BLOCKED at the engine layer: POST /api/workflow/decision -> HTTP 409 transition_refused (deterministic, CLI retried 4x). Three-layer read-only diagnosis done: binding replay returns 1 (layer 1 excluded), request did reach the server (layer 2 excluded), run is healthy (status=active, current_node=qa, my node running, engine_owned=1) and the manifest HAS the qa_pass edge, credential valid+unconsumed+unexpired, workflow_claims for my exec = 0 rows (verdict NOT recorded). Escalated to Lead with the full replay; not retrying, not touching the credential. Full 2921-char verdict preserved in ~/.flywheel/state/qa-result-failed/<exec>.json. Ship report hosted OK (https://fw-reports-a53de2.vercel.app/r/a877490b49754c747850d588a226f667/, HTTP 200) but Discord delivery 404 issue_thread_not_found - handed to Lead for manual delivery. PR #808 is OPEN with head 82aa2687 == verified head. 529 room left running for possible re-verification.
