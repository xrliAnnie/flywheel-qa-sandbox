---
issue: FLY-3228
phase: design
phaseCursor: 5/5
updated: 2026-10-05T03:13:01.958Z
nextStep: "Design complete (Codex r2 APPROVED, HTML published, run ad2ead99);
  implement node: hand-in #1 per plan §3"
chunks: []
pointers:
  plan: engineering/doc/FLY-3228-real-runner-drill/plan.md
  pr: https://github.com/xrliAnnie/flywheel-qa-sandbox/pull/551
handoff: |-
  Rework attempt 2 for run dce567d4, activation rework:496b890da1fbcbc49acff38043068bdb570da0a444cd36dd5ffed16f3cff4669, epoch 4. Exact original QA fix context received in thread and independently read from own CommDB runner_phase_wakes queue_seq=2: claim 1 on HANDIN1=63613f566616db99e20eee88b96192a673b95bff. Fix commit b27d7e9a0 changes only line 2 AWAITING-QA -> FIXED-FOR-CLAIM 1. Red cmp before change; green exact bytes after. Negative probes reject stale awaiting, wrong claim 2, leading-zero claim 01, extra line, trailing whitespace, missing final newline. Identical committed bytes pass retry/no-rewrite guard. Runtime queued/started/dead/superseded/concurrent states not applicable to two-line Markdown; no code or TS changes. e2e_529_exempt remains docs_only; no room deployment. pnpm lint exit 1 solely on two ignored generated design JSON formatting errors plus 14 existing warnings. No pre_handin.script. Final ledger commit before frozen HANDIN2 review/CI; final SHA recorded externally.

  Local selection: no drill literal/path test matches; generic progress.md test matches excluded individually because only generated cursor/text changes, parser/schema unchanged:
  EXCLUDED packages/claude-runner/test/codex-daemon-adapter-helpers.test.ts: generic progress-ledger reference; only generated cursor/text changes, parser and schema unchanged
  EXCLUDED packages/config/src/__tests__/progress-path-resolver.test.ts: generic progress-ledger reference; only generated cursor/text changes, parser and schema unchanged
  EXCLUDED packages/config/src/__tests__/progress-schema.test.ts: generic progress-ledger reference; only generated cursor/text changes, parser and schema unchanged
  EXCLUDED packages/edge-worker/src/__tests__/__snapshots__/Blueprint.fly1188-codex-prompt.test.ts.snap: generic progress-ledger reference; only generated cursor/text changes, parser and schema unchanged
  EXCLUDED packages/edge-worker/src/__tests__/resume-mode.test.ts: generic progress-ledger reference; only generated cursor/text changes, parser and schema unchanged
  EXCLUDED packages/flywheel-comm/src/commands/__tests__/progress.realgit.test.ts: generic progress-ledger reference; only generated cursor/text changes, parser and schema unchanged
  EXCLUDED packages/flywheel-comm/src/commands/__tests__/progress.test.ts: generic progress-ledger reference; only generated cursor/text changes, parser and schema unchanged
  EXCLUDED packages/teamlead/src/bridge/__tests__/progress-resume.test.ts: generic progress-ledger reference; only generated cursor/text changes, parser and schema unchanged
  EXCLUDED packages/teamlead/src/bridge/__tests__/run-dispatcher-resume.test.ts: generic progress-ledger reference; only generated cursor/text changes, parser and schema unchanged
  EXCLUDED packages/teamlead/src/bridge/__tests__/stale-approved-ship-reconciler.test.ts: generic progress-ledger reference; only generated cursor/text changes, parser and schema unchanged
---

# FLY-3228 progress
**phase**: design (5/5)
**next**: Design complete (Codex r2 APPROVED, HTML published, run ad2ead99); implement node: hand-in #1 per plan §3

**handoff**: Rework attempt 2 for run dce567d4, activation rework:496b890da1fbcbc49acff38043068bdb570da0a444cd36dd5ffed16f3cff4669, epoch 4. Exact original QA fix context received in thread and independently read from own CommDB runner_phase_wakes queue_seq=2: claim 1 on HANDIN1=63613f566616db99e20eee88b96192a673b95bff. Fix commit b27d7e9a0 changes only line 2 AWAITING-QA -> FIXED-FOR-CLAIM 1. Red cmp before change; green exact bytes after. Negative probes reject stale awaiting, wrong claim 2, leading-zero claim 01, extra line, trailing whitespace, missing final newline. Identical committed bytes pass retry/no-rewrite guard. Runtime queued/started/dead/superseded/concurrent states not applicable to two-line Markdown; no code or TS changes. e2e_529_exempt remains docs_only; no room deployment. pnpm lint exit 1 solely on two ignored generated design JSON formatting errors plus 14 existing warnings. No pre_handin.script. Final ledger commit before frozen HANDIN2 review/CI; final SHA recorded externally.

Local selection: no drill literal/path test matches; generic progress.md test matches excluded individually because only generated cursor/text changes, parser/schema unchanged:
EXCLUDED packages/claude-runner/test/codex-daemon-adapter-helpers.test.ts: generic progress-ledger reference; only generated cursor/text changes, parser and schema unchanged
EXCLUDED packages/config/src/__tests__/progress-path-resolver.test.ts: generic progress-ledger reference; only generated cursor/text changes, parser and schema unchanged
EXCLUDED packages/config/src/__tests__/progress-schema.test.ts: generic progress-ledger reference; only generated cursor/text changes, parser and schema unchanged
EXCLUDED packages/edge-worker/src/__tests__/__snapshots__/Blueprint.fly1188-codex-prompt.test.ts.snap: generic progress-ledger reference; only generated cursor/text changes, parser and schema unchanged
EXCLUDED packages/edge-worker/src/__tests__/resume-mode.test.ts: generic progress-ledger reference; only generated cursor/text changes, parser and schema unchanged
EXCLUDED packages/flywheel-comm/src/commands/__tests__/progress.realgit.test.ts: generic progress-ledger reference; only generated cursor/text changes, parser and schema unchanged
EXCLUDED packages/flywheel-comm/src/commands/__tests__/progress.test.ts: generic progress-ledger reference; only generated cursor/text changes, parser and schema unchanged
EXCLUDED packages/teamlead/src/bridge/__tests__/progress-resume.test.ts: generic progress-ledger reference; only generated cursor/text changes, parser and schema unchanged
EXCLUDED packages/teamlead/src/bridge/__tests__/run-dispatcher-resume.test.ts: generic progress-ledger reference; only generated cursor/text changes, parser and schema unchanged
EXCLUDED packages/teamlead/src/bridge/__tests__/stale-approved-ship-reconciler.test.ts: generic progress-ledger reference; only generated cursor/text changes, parser and schema unchanged
