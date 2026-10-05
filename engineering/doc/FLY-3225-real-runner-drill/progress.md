---
issue: FLY-3225
phase: design
phaseCursor: 5/6
updated: 2026-10-05T06:37:25.446Z
nextStep: Await effective design verdict; APPROVED permits phase_design_complete
  then park, CHANGES requires a new review round.
chunks: []
pointers:
  plan: engineering/doc/FLY-3225-real-runner-drill/plan.md
  reviewedSha: d76868bf59a2a3ab09c1a070381f899c688ae0ca
handoff: '{"runId":"11162b6f-3557-4d40-936a-7a7fae53dd12","execId":"1bffed8c-a115-4df1-bfb8-f897ed247bec","designExecId":"1bffed8c-a115-4df1-bfb8-f897ed247bec","activationId":"activation:1bffed8c-a115-4df1-bfb8-f897ed247bec:11162b6f-3557-4d40-936a-7a7fae53dd12:eng_design:1","attempt":1,"turnEpoch":1,"designBase":"cc7ddcfb289a36da3c0c3754a86ffa3e5ff3436a","readmeMain":"62a604d441b959318623292e07bf8af9ebdc28b3","readmeBlob":"f025871e500834ce5bab62335a4d29bd6b308d78","taskPath":"qa-sbx/fly3225/project-slot-3-FLY-3225.md","inheritedLine2":"AWAITING-QA","pr":576,"prUrl":"https://github.com/xrliAnnie/flywheel-qa-sandbox/pull/576","documentPolicy":"Main
  README requires one short plan, no separate research document. Exploration and
  research are inline; mandatory HTML, Mermaid sources and tool-owned progress
  remain phase
  deliverables.","completionRoute":"phase_design_complete","phaseKeepAlive":"Complete
  accepted design phase, then park; goal stays active until issue-terminal
  shutdown.","designStatus":"Current-run review registered; HTML committed,
  pushed, published and reported. Await effective APPROVED before exact phase
  completion.","researchStatus":"Current README and fixture inspected; no
  runtime consumers found by bounded repository search. Inline research
  only.","reviewLocalTestPolicy":"Verified entire marked block matches
  CODEX_HOME/AGENTS.md and injected reviewer asset byte for byte; coordinator
  prepends it as first bytes.","localTests":"local-tests: no modified tests,
  direct tests or declared smoke
  set.","planWritten":true,"steStatus":"disabled","htmlPath":"engineering/doc/FLY-3225-real-runner-drill/design.html","designArtifactCommit":"d76868bf59a2a3ab09c1a070381f899c688ae0ca","planBlob":"77589dbe8d1b7db4cacd356cfcd494baaaf7dd57","htmlCommittedSha256":"6267460e52ba609890d5475761e05d3a4cc151c0466b5f12588a6844b3fdc8c3","htmlLocalVerification":"PASS:
  six per-section comments; two accessible SVGs with unique IDs; path-isolated
  autosave/reload; storage blocked; <=1800-char marked chunks; clipboard
  success, missing and rejected fallbacks; escaped literal rendering; nonce CSP;
  zero external requests/browser errors; mobile no page
  overflow.","diagramVerification":"Two mmdc local renders, accessible-SVG skill
  checks and screenshot inspection passed.","lint":"pnpm lint exit 0; 14
  existing warnings, no fixes
  applied.","designQuestionId":"18003774-d68d-4bbf-a110-b922b1eea604","designReviewRequestId":"789ac616-1da0-4b39-a6d2-60bdcef47cb8","reviewRegistration":"accepted=true;
  skipped=false; duplicate=false","designReviewStatus":"Registered; effective
  verdict
  pending.","htmlPublished":true,"htmlUrl":"http://127.0.0.1:50762/fw-reports-2f4b5c/r/80ef2d3bd8905ba242580124ce3503f5/","htmlReportId":"80ef2d3bd8905ba242580124ce3503f5","htmlPublishOnly":true,"htmlReportReceipt":"a614515d-2c35-45f1-813a-6ccb5e7b4e01","htmlHostedSha256":"031ba709daba0ae512751062ada58eb4eeef779dd4314d20b361d74232bd79f5","htmlHostedVerification":"PASS:
  HTTP 200, current-run identity, minted nonce authorized by injected CSP, six
  comments/live aggregate/reload persistence, two SVGs, no external
  requests/browser errors.","designLastCheck":"not
  yet","completionStatus":"Pending effective design verdict; resident goal
  remains active."}'
---

# FLY-3225 progress
**phase**: design (5/6)
**next**: Await effective design verdict; APPROVED permits phase_design_complete then park, CHANGES requires a new review round.

**handoff**: {"runId":"11162b6f-3557-4d40-936a-7a7fae53dd12","execId":"1bffed8c-a115-4df1-bfb8-f897ed247bec","designExecId":"1bffed8c-a115-4df1-bfb8-f897ed247bec","activationId":"activation:1bffed8c-a115-4df1-bfb8-f897ed247bec:11162b6f-3557-4d40-936a-7a7fae53dd12:eng_design:1","attempt":1,"turnEpoch":1,"designBase":"cc7ddcfb289a36da3c0c3754a86ffa3e5ff3436a","readmeMain":"62a604d441b959318623292e07bf8af9ebdc28b3","readmeBlob":"f025871e500834ce5bab62335a4d29bd6b308d78","taskPath":"qa-sbx/fly3225/project-slot-3-FLY-3225.md","inheritedLine2":"AWAITING-QA","pr":576,"prUrl":"https://github.com/xrliAnnie/flywheel-qa-sandbox/pull/576","documentPolicy":"Main README requires one short plan, no separate research document. Exploration and research are inline; mandatory HTML, Mermaid sources and tool-owned progress remain phase deliverables.","completionRoute":"phase_design_complete","phaseKeepAlive":"Complete accepted design phase, then park; goal stays active until issue-terminal shutdown.","designStatus":"Current-run review registered; HTML committed, pushed, published and reported. Await effective APPROVED before exact phase completion.","researchStatus":"Current README and fixture inspected; no runtime consumers found by bounded repository search. Inline research only.","reviewLocalTestPolicy":"Verified entire marked block matches CODEX_HOME/AGENTS.md and injected reviewer asset byte for byte; coordinator prepends it as first bytes.","localTests":"local-tests: no modified tests, direct tests or declared smoke set.","planWritten":true,"steStatus":"disabled","htmlPath":"engineering/doc/FLY-3225-real-runner-drill/design.html","designArtifactCommit":"d76868bf59a2a3ab09c1a070381f899c688ae0ca","planBlob":"77589dbe8d1b7db4cacd356cfcd494baaaf7dd57","htmlCommittedSha256":"6267460e52ba609890d5475761e05d3a4cc151c0466b5f12588a6844b3fdc8c3","htmlLocalVerification":"PASS: six per-section comments; two accessible SVGs with unique IDs; path-isolated autosave/reload; storage blocked; <=1800-char marked chunks; clipboard success, missing and rejected fallbacks; escaped literal rendering; nonce CSP; zero external requests/browser errors; mobile no page overflow.","diagramVerification":"Two mmdc local renders, accessible-SVG skill checks and screenshot inspection passed.","lint":"pnpm lint exit 0; 14 existing warnings, no fixes applied.","designQuestionId":"18003774-d68d-4bbf-a110-b922b1eea604","designReviewRequestId":"789ac616-1da0-4b39-a6d2-60bdcef47cb8","reviewRegistration":"accepted=true; skipped=false; duplicate=false","designReviewStatus":"Registered; effective verdict pending.","htmlPublished":true,"htmlUrl":"http://127.0.0.1:50762/fw-reports-2f4b5c/r/80ef2d3bd8905ba242580124ce3503f5/","htmlReportId":"80ef2d3bd8905ba242580124ce3503f5","htmlPublishOnly":true,"htmlReportReceipt":"a614515d-2c35-45f1-813a-6ccb5e7b4e01","htmlHostedSha256":"031ba709daba0ae512751062ada58eb4eeef779dd4314d20b361d74232bd79f5","htmlHostedVerification":"PASS: HTTP 200, current-run identity, minted nonce authorized by injected CSP, six comments/live aggregate/reload persistence, two SVGs, no external requests/browser errors.","designLastCheck":"not yet","completionStatus":"Pending effective design verdict; resident goal remains active."}
