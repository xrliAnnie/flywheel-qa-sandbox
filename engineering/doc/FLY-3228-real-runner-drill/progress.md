---
issue: FLY-3228
phase: implement
phaseCursor: 3/5
updated: 2026-10-05T03:34:39.987Z
nextStep: Exact-head code review for HANDIN2, then freeze and run server-owned
  CI requirement
chunks: []
pointers:
  plan: engineering/doc/FLY-3228-real-runner-drill/plan.md
  pr: https://github.com/xrliAnnie/flywheel-qa-sandbox/pull/575
handoff: "Rework attempt 2 for run ad2ead99, activation
  rework:4c5c31e8437584cea1c91308fe177c19b1e44552b5498d7b2ab3aed201e26f4f, epoch
  4. Authoritative QA fix context first line supplied claim 1 on PREV/HANDIN1
  3f8829e039947fcff2efface1b78759c85580772. Fixture is exactly QA-SBX FLY-3228
  drill / FIXED-FOR-CLAIM 1. PREV-to-current patch changes only line 2 plus
  progress.md. Exact bytes and six adjacent malformed/stale input probes pass;
  no runtime state machine exists, so
  queued/started/dead/superseded/retried/concurrent are not applicable.
  local-tests selects no changed/direct/smoke tests. e2e_529_exempt remains
  not_run docs_only; no room deployment. PR #575."
---

# FLY-3228 progress
**phase**: implement (3/5)
**next**: Exact-head code review for HANDIN2, then freeze and run server-owned CI requirement

**handoff**: Rework attempt 2 for run ad2ead99, activation rework:4c5c31e8437584cea1c91308fe177c19b1e44552b5498d7b2ab3aed201e26f4f, epoch 4. Authoritative QA fix context first line supplied claim 1 on PREV/HANDIN1 3f8829e039947fcff2efface1b78759c85580772. Fixture is exactly QA-SBX FLY-3228 drill / FIXED-FOR-CLAIM 1. PREV-to-current patch changes only line 2 plus progress.md. Exact bytes and six adjacent malformed/stale input probes pass; no runtime state machine exists, so queued/started/dead/superseded/retried/concurrent are not applicable. local-tests selects no changed/direct/smoke tests. e2e_529_exempt remains not_run docs_only; no room deployment. PR #575.
