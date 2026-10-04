---
issue: FLY-3227
phase: design
phaseCursor: 3/6
updated: 2026-10-04T15:13:22.909Z
nextStep: "Short plan refreshed with exploration/local research and exact
  fixture/QA rules; README forbids research document, so no extra
  exploration/research files. Mandatory design.html and locally rendered Mermaid
  FLY-3227-d1 SVG refreshed; fixture untouched. Full browser verification PASS
  under nonce CSP: six section inputs, reload restore, same-origin path
  isolation, Unicode long chunks with exact marker per <=1800 codepoints, inert
  derived text, clipboard success/missing/reject fallback, storage read/write
  failure, zero page errors/external requests, desktop/mobile width; diagram
  visually inspected. pnpm lint exit 0, 14 warnings in unchanged files; git diff
  --check and document metadata/scope audit PASS. Old/new literal plus
  full-path/filename/parent discovery has no issue-artifact test consumers.
  EXCLUDED engineering/spike/FLY-1006-eleven/serve.test.mjs: unrelated spike
  server plan filename, no dependency on this issue artifacts | EXCLUDED
  packages/claude-runner/test/codex-daemon-adapter-helpers.test.ts: generic
  plan/progress filename sample; only issue prose/generated ledger changes, no
  corresponding runtime or schema changes | EXCLUDED
  packages/config/src/__tests__/progress-path-resolver.test.ts: generic
  plan/progress filename sample; only issue prose/generated ledger changes, no
  corresponding runtime or schema changes | EXCLUDED
  packages/config/src/__tests__/progress-schema.test.ts: generic plan/progress
  filename sample; only issue prose/generated ledger changes, no corresponding
  runtime or schema changes | EXCLUDED
  packages/edge-worker/src/__tests__/Blueprint.fly205-doc-flow.test.ts: generic
  plan/progress filename sample; only issue prose/generated ledger changes, no
  corresponding runtime or schema changes | EXCLUDED
  packages/edge-worker/src/__tests__/__snapshots__/Blueprint.fly1188-codex-prom\
  pt.test.ts.snap: generic plan/progress filename sample; only issue
  prose/generated ledger changes, no corresponding runtime or schema changes |
  EXCLUDED packages/edge-worker/src/__tests__/resume-mode.test.ts: generic
  plan/progress filename sample; only issue prose/generated ledger changes, no
  corresponding runtime or schema changes | EXCLUDED
  packages/flywheel-comm/src/__tests__/request-review.test.ts: generic
  plan/progress filename sample; only issue prose/generated ledger changes, no
  corresponding runtime or schema changes | EXCLUDED
  packages/flywheel-comm/src/commands/__tests__/progress.realgit.test.ts:
  generic plan/progress filename sample; only issue prose/generated ledger
  changes, no corresponding runtime or schema changes | EXCLUDED
  packages/flywheel-comm/src/commands/__tests__/progress.test.ts: generic
  plan/progress filename sample; only issue prose/generated ledger changes, no
  corresponding runtime or schema changes | EXCLUDED
  packages/teamlead/src/__tests__/fly1135-doc-sentinel.test.ts: generic
  plan/progress filename sample; only issue prose/generated ledger changes, no
  corresponding runtime or schema changes | EXCLUDED
  packages/teamlead/src/bridge/__tests__/fixtures/error-panes/fn1-enoent-loop-f\
  rame1.txt: static historical error-pane fixture, not a consumer of this issue
  document | EXCLUDED
  packages/teamlead/src/bridge/__tests__/fixtures/error-panes/fn1-enoent-loop-f\
  rame2.txt: static historical error-pane fixture, not a consumer of this issue
  document | EXCLUDED
  packages/teamlead/src/bridge/__tests__/lifecycle-closeout.test.ts: generic
  plan/progress filename sample; only issue prose/generated ledger changes, no
  corresponding runtime or schema changes | EXCLUDED
  packages/teamlead/src/bridge/__tests__/progress-resume.test.ts: generic
  plan/progress filename sample; only issue prose/generated ledger changes, no
  corresponding runtime or schema changes | EXCLUDED
  packages/teamlead/src/bridge/__tests__/review-request-coordinator.test.ts:
  generic plan/progress filename sample; only issue prose/generated ledger
  changes, no corresponding runtime or schema changes | EXCLUDED
  packages/teamlead/src/bridge/__tests__/run-dispatcher-resume.test.ts: generic
  plan/progress filename sample; only issue prose/generated ledger changes, no
  corresponding runtime or schema changes | EXCLUDED
  packages/teamlead/src/bridge/__tests__/stale-approved-ship-reconciler.test.ts:
  generic plan/progress filename sample; only issue prose/generated ledger
  changes, no corresponding runtime or schema changes | EXCLUDED
  packages/voice-core/src/__tests__/announcer.test.ts: generic plan/progress
  filename sample; only issue prose/generated ledger changes, no corresponding
  runtime or schema changes | EXCLUDED
  packages/voice-core/src/__tests__/extra-tools.test.ts: generic plan/progress
  filename sample; only issue prose/generated ledger changes, no corresponding
  runtime or schema changes. No TypeScript/API/package changes, so
  related/build/typecheck inapplicable; no new shell tests or local full suites.
  Mandatory server review prompt source and exact copied policy block verified.
  STE begin disabled, no unitId. Next commit and push design artifacts, stage
  design_review, open gate and register current-execution review. No
  implementation/Linear/room/successor/ship/merge actions."
chunks: []
pointers: {}
---

# FLY-3227 progress
**phase**: design (3/6)
**next**: Short plan refreshed with exploration/local research and exact fixture/QA rules; README forbids research document, so no extra exploration/research files. Mandatory design.html and locally rendered Mermaid FLY-3227-d1 SVG refreshed; fixture untouched. Full browser verification PASS under nonce CSP: six section inputs, reload restore, same-origin path isolation, Unicode long chunks with exact marker per <=1800 codepoints, inert derived text, clipboard success/missing/reject fallback, storage read/write failure, zero page errors/external requests, desktop/mobile width; diagram visually inspected. pnpm lint exit 0, 14 warnings in unchanged files; git diff --check and document metadata/scope audit PASS. Old/new literal plus full-path/filename/parent discovery has no issue-artifact test consumers. EXCLUDED engineering/spike/FLY-1006-eleven/serve.test.mjs: unrelated spike server plan filename, no dependency on this issue artifacts | EXCLUDED packages/claude-runner/test/codex-daemon-adapter-helpers.test.ts: generic plan/progress filename sample; only issue prose/generated ledger changes, no corresponding runtime or schema changes | EXCLUDED packages/config/src/__tests__/progress-path-resolver.test.ts: generic plan/progress filename sample; only issue prose/generated ledger changes, no corresponding runtime or schema changes | EXCLUDED packages/config/src/__tests__/progress-schema.test.ts: generic plan/progress filename sample; only issue prose/generated ledger changes, no corresponding runtime or schema changes | EXCLUDED packages/edge-worker/src/__tests__/Blueprint.fly205-doc-flow.test.ts: generic plan/progress filename sample; only issue prose/generated ledger changes, no corresponding runtime or schema changes | EXCLUDED packages/edge-worker/src/__tests__/__snapshots__/Blueprint.fly1188-codex-prompt.test.ts.snap: generic plan/progress filename sample; only issue prose/generated ledger changes, no corresponding runtime or schema changes | EXCLUDED packages/edge-worker/src/__tests__/resume-mode.test.ts: generic plan/progress filename sample; only issue prose/generated ledger changes, no corresponding runtime or schema changes | EXCLUDED packages/flywheel-comm/src/__tests__/request-review.test.ts: generic plan/progress filename sample; only issue prose/generated ledger changes, no corresponding runtime or schema changes | EXCLUDED packages/flywheel-comm/src/commands/__tests__/progress.realgit.test.ts: generic plan/progress filename sample; only issue prose/generated ledger changes, no corresponding runtime or schema changes | EXCLUDED packages/flywheel-comm/src/commands/__tests__/progress.test.ts: generic plan/progress filename sample; only issue prose/generated ledger changes, no corresponding runtime or schema changes | EXCLUDED packages/teamlead/src/__tests__/fly1135-doc-sentinel.test.ts: generic plan/progress filename sample; only issue prose/generated ledger changes, no corresponding runtime or schema changes | EXCLUDED packages/teamlead/src/bridge/__tests__/fixtures/error-panes/fn1-enoent-loop-frame1.txt: static historical error-pane fixture, not a consumer of this issue document | EXCLUDED packages/teamlead/src/bridge/__tests__/fixtures/error-panes/fn1-enoent-loop-frame2.txt: static historical error-pane fixture, not a consumer of this issue document | EXCLUDED packages/teamlead/src/bridge/__tests__/lifecycle-closeout.test.ts: generic plan/progress filename sample; only issue prose/generated ledger changes, no corresponding runtime or schema changes | EXCLUDED packages/teamlead/src/bridge/__tests__/progress-resume.test.ts: generic plan/progress filename sample; only issue prose/generated ledger changes, no corresponding runtime or schema changes | EXCLUDED packages/teamlead/src/bridge/__tests__/review-request-coordinator.test.ts: generic plan/progress filename sample; only issue prose/generated ledger changes, no corresponding runtime or schema changes | EXCLUDED packages/teamlead/src/bridge/__tests__/run-dispatcher-resume.test.ts: generic plan/progress filename sample; only issue prose/generated ledger changes, no corresponding runtime or schema changes | EXCLUDED packages/teamlead/src/bridge/__tests__/stale-approved-ship-reconciler.test.ts: generic plan/progress filename sample; only issue prose/generated ledger changes, no corresponding runtime or schema changes | EXCLUDED packages/voice-core/src/__tests__/announcer.test.ts: generic plan/progress filename sample; only issue prose/generated ledger changes, no corresponding runtime or schema changes | EXCLUDED packages/voice-core/src/__tests__/extra-tools.test.ts: generic plan/progress filename sample; only issue prose/generated ledger changes, no corresponding runtime or schema changes. No TypeScript/API/package changes, so related/build/typecheck inapplicable; no new shell tests or local full suites. Mandatory server review prompt source and exact copied policy block verified. STE begin disabled, no unitId. Next commit and push design artifacts, stage design_review, open gate and register current-execution review. No implementation/Linear/room/successor/ship/merge actions.
