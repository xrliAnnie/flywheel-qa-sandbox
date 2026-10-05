---
issue: FLY-3224
phase: implement
phaseCursor: 2/4
updated: 2026-10-05T08:25:52.181Z
nextStep: Push and freeze revised HEAD; open new code-review gate/request for
  this rework, then ci-full ensure server-owned policy, complete needs_review
  --pr 580 and park for QA retest.
chunks: []
pointers:
  pr: "580"
handoff: "run=8794dd59-6028-4df4-895b-1d0124bf0cb1
  implementExec=f1a2105c-d4c3-414c-9f3e-c089cbb0374f attempt=2 epoch=4
  activation=activation:rework:29e8bf05ea94fb0f4e9d78c5da6662ac3a7f199e2b81aa1e\
  1d50fbc77a73c0ef
  request=rework:29e8bf05ea94fb0f4e9d78c5da6662ac3a7f199e2b81aa1e1d50fbc77a73c0\
  ef. QA verdict claim 1 qa_failed on
  baseRevision=6755e2fdb2afe75aeb2d815ff775a1cc7b58683d; claim id taken only
  from first line of injected QA fix context. Fixed criterion fixed-for-claim
  via commit 95835795b0c149ae039fc74d2b352e0cfed95c48: second line AWAITING-QA
  -> FIXED-FOR-CLAIM 1; first line and two-LF shape unchanged. Current-run
  first_handin=8e997979718903558ca68b6bdd23e6403c9eb14a remains verified
  ancestor with AWAITING-QA; CLI custom pointer limitation accepted by Lead,
  durable handoff is source. Fresh main README reread; approved plan unchanged.
  Local exact-byte check red before fix and green after; wrong-claim comparison,
  first-handin/base ancestry, unchanged first line, replay-no-edit shape and
  fixture-only diff verified. Runtime
  queued/started/dead/superseded/retried/concurrent paths not applicable: no
  code; no test files added, local-tests declares none/smoke none; pnpm lint
  exit 0 with 14 existing warnings. e2e_529_exempt stays not_run docs_only
  reason Markdown-only drill; no room deployment. Protocol ledger is sole
  additional rework path; 9-entry whitelist covers existing design docs and
  fixture; no milestone/research. Final rework head and review/CI/needs_review
  receipts will be reported without further commits. Reuse PR
  https://github.com/xrliAnnie/flywheel-qa-sandbox/pull/580. QA must bind
  verdict to delivered head before ledger commit. No Linear mutation, QA
  dispatch, deploy or merge."
---

# FLY-3224 progress
**phase**: implement (2/4)
**next**: Push and freeze revised HEAD; open new code-review gate/request for this rework, then ci-full ensure server-owned policy, complete needs_review --pr 580 and park for QA retest.

**handoff**: run=8794dd59-6028-4df4-895b-1d0124bf0cb1 implementExec=f1a2105c-d4c3-414c-9f3e-c089cbb0374f attempt=2 epoch=4 activation=activation:rework:29e8bf05ea94fb0f4e9d78c5da6662ac3a7f199e2b81aa1e1d50fbc77a73c0ef request=rework:29e8bf05ea94fb0f4e9d78c5da6662ac3a7f199e2b81aa1e1d50fbc77a73c0ef. QA verdict claim 1 qa_failed on baseRevision=6755e2fdb2afe75aeb2d815ff775a1cc7b58683d; claim id taken only from first line of injected QA fix context. Fixed criterion fixed-for-claim via commit 95835795b0c149ae039fc74d2b352e0cfed95c48: second line AWAITING-QA -> FIXED-FOR-CLAIM 1; first line and two-LF shape unchanged. Current-run first_handin=8e997979718903558ca68b6bdd23e6403c9eb14a remains verified ancestor with AWAITING-QA; CLI custom pointer limitation accepted by Lead, durable handoff is source. Fresh main README reread; approved plan unchanged. Local exact-byte check red before fix and green after; wrong-claim comparison, first-handin/base ancestry, unchanged first line, replay-no-edit shape and fixture-only diff verified. Runtime queued/started/dead/superseded/retried/concurrent paths not applicable: no code; no test files added, local-tests declares none/smoke none; pnpm lint exit 0 with 14 existing warnings. e2e_529_exempt stays not_run docs_only reason Markdown-only drill; no room deployment. Protocol ledger is sole additional rework path; 9-entry whitelist covers existing design docs and fixture; no milestone/research. Final rework head and review/CI/needs_review receipts will be reported without further commits. Reuse PR https://github.com/xrliAnnie/flywheel-qa-sandbox/pull/580. QA must bind verdict to delivered head before ledger commit. No Linear mutation, QA dispatch, deploy or merge.
