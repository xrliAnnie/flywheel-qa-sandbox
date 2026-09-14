---
issue: FLY-2362
phase: implement
phaseCursor: 5/6
updated: 2026-09-13T23:08:41.546Z
nextStep: Doc-only rework verified; milestone-only last commit, ordinary push,
  new exact-head review and CI
chunks: []
pointers: {}
handoff: >
  Final approved scope (Lead gate e896e105-af0a-44d5-8a7b-9bce4b96f893):
  withdraw deletion, retain reachable router/executor turn observation and
  turn_stalled; document the unobserved /goal path; use doc-only plus followup
  because existing executor hook cannot safely adopt foreign turns. Short plan:
  restore all runtime/config/test/script bytes to26ebc4931; document
  path/evidence boundaries and followup; run restored controls and lint/build;
  milestone-last PR; fresh exact-head review/CI; report and needs_review
  completion.


  Implemented dd3a9a347: git diff26ebc4931 HEAD -- packages scripts is empty.
  Carrier doc doc/architecture/codex-lead-turn-observation.md and seven
  historical-doc corrections. Followup FLY-2540
  https://linear.app/geoforge3d/issue/FLY-2540 created without dispatch.
  Read-only mufasa lifecycle106 turn_started/15 completed/91 failed (first
  start2026-09-03T07:07:02.954Z,last2026-09-13T18:00:56.005Z) disproves blanket
  TUI-dead premise; does not prove /goal coverage. Hook runs only after
  executor-owned startTurn RPC; demux sends foreign turns to completion-only
  observer. Reusing hook needs passive ownership/attach/dedup semantics; bounded
  doc-only ruling applies.


  Review1 question9f315b21-5af9-4f75-9c03-0b0681385ddc
  requestfc0318b1-22dd-48d3-9791-9fb88e711155 at6ac820285: CHANGES_REQUESTED
  HIGH tui-turn-observation-is-live. Restoring original code resolves HIGH and
  reader-writer-skew/dead-interface advisories. Original b ruling
  dfa1a0ce-85e8-4069-96ba-822d47d607b8 is superseded. Reports
  b0ef4312-174b-419c-8b6d-e2e6c20dc7bf and ea84ec06-9ba4-4887-b85c-cb5ceba5d296
  convey evidence and disposition. PR1171 must be reviewed at new HEAD.


  Final verification: restored4 suites70 passed, including turn_stalled positive
  control/executor hooks/foreign isolation (/tmp/fly2362-restored.log); final
  pnpm lint exit0 with16 warnings and pnpm -r build exit0
  (/tmp/fly2362-final-lint.log,/tmp/fly2362-final-build.log). These are boundary
  controls, not /goal coverage. Earlier deletion tests2 RED then70 GREEN are
  superseded by restoration; config39 and recovery-shell18 passed during that
  attempt.


  Aggregate receipts remain FAILED: /tmp/fly2362-packages.log exit1 Comm8
  failed2472 passed3 skipped and worker timeout, seven timeouts plus
  stop-declaration race expected sent/sent got stale/sent. Only real
  Terminal.app core GUI test excluded through temporary config restored
  afterward. Completed other packages
  release-contract/core/token-usage/qa-framework/config/GitHub/Linear/Slack
  transports/voice-core. Supplemental /tmp/fly2362-teamlead.log exit1:18
  failed13582 passed7 skipped,9 failed files1005 passed and worker timeout;
  failures outside changed paths. /tmp/fly2362-remaining.log bailed at
  claude-runner exit1:6 failed1262 passed2 skipped,5 failed files45 passed,2
  errors; five later packages not run. All process handles completed. No
  aggregate failure reruns or unrelated fixes.


  Lead8413a9d5-6d30-453d-aefe-6799628b2b89 approves Bridge cross-family
  exact-head code gate and exact-head CI adjudication, no fix/rerun of local
  race. codex:rescue failed pre-thread with sandbox helper exit71 sandbox_apply
  Operation not permitted (/tmp/fly2362-rescue.log), declared out of scope.
  Still needs final-head Bridge review/CI receipts, final report, memory
  closeout and complete --route needs_review --pr1171, then park. No
  deployment/schema change, no merge, no QA dispatch. Progress body is
  generated; this handoff field is durable.
---

# FLY-2362 progress
**phase**: implement (5/6)
**next**: Doc-only rework verified; milestone-only last commit, ordinary push, new exact-head review and CI

**handoff**: Final approved scope (Lead gate e896e105-af0a-44d5-8a7b-9bce4b96f893): withdraw deletion, retain reachable router/executor turn observation and turn_stalled; document the unobserved /goal path; use doc-only plus followup because existing executor hook cannot safely adopt foreign turns. Short plan: restore all runtime/config/test/script bytes to26ebc4931; document path/evidence boundaries and followup; run restored controls and lint/build; milestone-last PR; fresh exact-head review/CI; report and needs_review completion.

Implemented dd3a9a347: git diff26ebc4931 HEAD -- packages scripts is empty. Carrier doc doc/architecture/codex-lead-turn-observation.md and seven historical-doc corrections. Followup FLY-2540 https://linear.app/geoforge3d/issue/FLY-2540 created without dispatch. Read-only mufasa lifecycle106 turn_started/15 completed/91 failed (first start2026-09-03T07:07:02.954Z,last2026-09-13T18:00:56.005Z) disproves blanket TUI-dead premise; does not prove /goal coverage. Hook runs only after executor-owned startTurn RPC; demux sends foreign turns to completion-only observer. Reusing hook needs passive ownership/attach/dedup semantics; bounded doc-only ruling applies.

Review1 question9f315b21-5af9-4f75-9c03-0b0681385ddc requestfc0318b1-22dd-48d3-9791-9fb88e711155 at6ac820285: CHANGES_REQUESTED HIGH tui-turn-observation-is-live. Restoring original code resolves HIGH and reader-writer-skew/dead-interface advisories. Original b ruling dfa1a0ce-85e8-4069-96ba-822d47d607b8 is superseded. Reports b0ef4312-174b-419c-8b6d-e2e6c20dc7bf and ea84ec06-9ba4-4887-b85c-cb5ceba5d296 convey evidence and disposition. PR1171 must be reviewed at new HEAD.

Final verification: restored4 suites70 passed, including turn_stalled positive control/executor hooks/foreign isolation (/tmp/fly2362-restored.log); final pnpm lint exit0 with16 warnings and pnpm -r build exit0 (/tmp/fly2362-final-lint.log,/tmp/fly2362-final-build.log). These are boundary controls, not /goal coverage. Earlier deletion tests2 RED then70 GREEN are superseded by restoration; config39 and recovery-shell18 passed during that attempt.

Aggregate receipts remain FAILED: /tmp/fly2362-packages.log exit1 Comm8 failed2472 passed3 skipped and worker timeout, seven timeouts plus stop-declaration race expected sent/sent got stale/sent. Only real Terminal.app core GUI test excluded through temporary config restored afterward. Completed other packages release-contract/core/token-usage/qa-framework/config/GitHub/Linear/Slack transports/voice-core. Supplemental /tmp/fly2362-teamlead.log exit1:18 failed13582 passed7 skipped,9 failed files1005 passed and worker timeout; failures outside changed paths. /tmp/fly2362-remaining.log bailed at claude-runner exit1:6 failed1262 passed2 skipped,5 failed files45 passed,2 errors; five later packages not run. All process handles completed. No aggregate failure reruns or unrelated fixes.

Lead8413a9d5-6d30-453d-aefe-6799628b2b89 approves Bridge cross-family exact-head code gate and exact-head CI adjudication, no fix/rerun of local race. codex:rescue failed pre-thread with sandbox helper exit71 sandbox_apply Operation not permitted (/tmp/fly2362-rescue.log), declared out of scope. Still needs final-head Bridge review/CI receipts, final report, memory closeout and complete --route needs_review --pr1171, then park. No deployment/schema change, no merge, no QA dispatch. Progress body is generated; this handoff field is durable.

