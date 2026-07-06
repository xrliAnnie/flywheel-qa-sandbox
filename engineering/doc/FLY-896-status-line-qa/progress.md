---
issue: FLY-896
phase: implement
phaseCursor: 1/2
updated: 2026-07-06T03:53:51.620Z
nextStep: "Task 2: open PR to sandbox main; stage set pr_created; Codex code
  review; gate approve_to_ship --no-block + complete --route needs_review; park
  awaiting QA"
chunks: []
pointers: {}
handoff: "Design docs at a268a55. Lead mandate: QA MUST run one deliberate
  FAIL->wake->fix->RE-TEST->PASS round (verify.sh check 3 = missing terminal
  period is the planted target). Never merge to real branches."
---

# FLY-896 progress
**phase**: implement (1/2)
**next**: Task 2: open PR to sandbox main; stage set pr_created; Codex code review; gate approve_to_ship --no-block + complete --route needs_review; park awaiting QA

**handoff**: Design docs at a268a55. Lead mandate: QA MUST run one deliberate FAIL->wake->fix->RE-TEST->PASS round (verify.sh check 3 = missing terminal period is the planted target). Never merge to real branches.
