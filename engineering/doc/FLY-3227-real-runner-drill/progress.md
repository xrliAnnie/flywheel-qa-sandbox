---
issue: FLY-3227
phase: design
phaseCursor: 3/6
updated: 2026-10-04T10:53:10.598Z
nextStep: "Plan and mandatory HTML ready for commit/review. Local Mermaid render
  and accessible SVG check PASS. Nonced-CSP browser check PASS: all 6 sections
  have inputs, autosave/reload, pathname isolation, text-only unsafe input,
  <=1800-character chunks, Clipboard API, absent/rejected clipboard fallback,
  denied storage, mobile overflow, zero external requests/errors. Screenshots
  visually checked at /tmp/fly3227-design-7472a246/ (scratch only). pnpm lint
  exit 0 with 14 existing untouched warnings. Frontmatter, README criteria,
  query/index exemption, doc-only paths and unchanged target file PASS. Test
  discovery used changed full paths/filenames/parent and old/new changed
  literals. Retained tests: none; no TS/APIs/packages changed. Every excluded
  match has the same verified reason: generic plan.md/progress.md vocabulary or
  other-issue fixtures, no FLY-3227 artifact consumer. Excluded:
  engineering/spike/FLY-1006-eleven/serve.test.mjs;
  packages/claude-runner/test/codex-daemon-adapter-helpers.test.ts;
  packages/config/src/__tests__/progress-path-resolver.test.ts;
  packages/config/src/__tests__/progress-schema.test.ts;
  packages/edge-worker/src/__tests__/Blueprint.fly205-doc-flow.test.ts;
  packages/edge-worker/src/__tests__/__snapshots__/Blueprint.fly1188-codex-prom\
  pt.test.ts.snap; packages/edge-worker/src/__tests__/resume-mode.test.ts;
  packages/flywheel-comm/src/__tests__/request-review.test.ts;
  packages/flywheel-comm/src/commands/__tests__/progress.realgit.test.ts;
  packages/flywheel-comm/src/commands/__tests__/progress.test.ts;
  packages/teamlead/src/__tests__/fly1135-doc-sentinel.test.ts;
  packages/teamlead/src/bridge/__tests__/fixtures/error-panes/fn1-enoent-loop-f\
  rame1.txt;
  packages/teamlead/src/bridge/__tests__/fixtures/error-panes/fn1-enoent-loop-f\
  rame2.txt; packages/teamlead/src/bridge/__tests__/lifecycle-closeout.test.ts;
  packages/teamlead/src/bridge/__tests__/progress-resume.test.ts;
  packages/teamlead/src/bridge/__tests__/review-request-coordinator.test.ts;
  packages/teamlead/src/bridge/__tests__/run-dispatcher-resume.test.ts;
  packages/teamlead/src/bridge/__tests__/stale-approved-ship-reconciler.test.ts;
  packages/voice-core/src/__tests__/announcer.test.ts;
  packages/voice-core/src/__tests__/extra-tools.test.ts. Reviewer Bridge
  verified to prepend the exact marked local-test policy block. Next:
  commit/push four design artifacts; stage design_review and register new
  gate/request with committed plan blob; publish/report current committed HTML
  independently; await effective verdict across turns."
chunks: []
pointers: {}
---

# FLY-3227 progress
**phase**: design (3/6)
**next**: Plan and mandatory HTML ready for commit/review. Local Mermaid render and accessible SVG check PASS. Nonced-CSP browser check PASS: all 6 sections have inputs, autosave/reload, pathname isolation, text-only unsafe input, <=1800-character chunks, Clipboard API, absent/rejected clipboard fallback, denied storage, mobile overflow, zero external requests/errors. Screenshots visually checked at /tmp/fly3227-design-7472a246/ (scratch only). pnpm lint exit 0 with 14 existing untouched warnings. Frontmatter, README criteria, query/index exemption, doc-only paths and unchanged target file PASS. Test discovery used changed full paths/filenames/parent and old/new changed literals. Retained tests: none; no TS/APIs/packages changed. Every excluded match has the same verified reason: generic plan.md/progress.md vocabulary or other-issue fixtures, no FLY-3227 artifact consumer. Excluded: engineering/spike/FLY-1006-eleven/serve.test.mjs; packages/claude-runner/test/codex-daemon-adapter-helpers.test.ts; packages/config/src/__tests__/progress-path-resolver.test.ts; packages/config/src/__tests__/progress-schema.test.ts; packages/edge-worker/src/__tests__/Blueprint.fly205-doc-flow.test.ts; packages/edge-worker/src/__tests__/__snapshots__/Blueprint.fly1188-codex-prompt.test.ts.snap; packages/edge-worker/src/__tests__/resume-mode.test.ts; packages/flywheel-comm/src/__tests__/request-review.test.ts; packages/flywheel-comm/src/commands/__tests__/progress.realgit.test.ts; packages/flywheel-comm/src/commands/__tests__/progress.test.ts; packages/teamlead/src/__tests__/fly1135-doc-sentinel.test.ts; packages/teamlead/src/bridge/__tests__/fixtures/error-panes/fn1-enoent-loop-frame1.txt; packages/teamlead/src/bridge/__tests__/fixtures/error-panes/fn1-enoent-loop-frame2.txt; packages/teamlead/src/bridge/__tests__/lifecycle-closeout.test.ts; packages/teamlead/src/bridge/__tests__/progress-resume.test.ts; packages/teamlead/src/bridge/__tests__/review-request-coordinator.test.ts; packages/teamlead/src/bridge/__tests__/run-dispatcher-resume.test.ts; packages/teamlead/src/bridge/__tests__/stale-approved-ship-reconciler.test.ts; packages/voice-core/src/__tests__/announcer.test.ts; packages/voice-core/src/__tests__/extra-tools.test.ts. Reviewer Bridge verified to prepend the exact marked local-test policy block. Next: commit/push four design artifacts; stage design_review and register new gate/request with committed plan blob; publish/report current committed HTML independently; await effective verdict across turns.
