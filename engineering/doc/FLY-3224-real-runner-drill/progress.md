---
issue: FLY-3224
phase: implement
phaseCursor: 3/4
updated: 2026-10-05T10:38:21.614Z
nextStep: Update existing milestone as literal last commit, push, freeze final
  rework HEAD, update PR585, register fresh effective code review; after
  approval ensure CI and complete needs_review.
chunks: []
pointers:
  pr: "585"
handoff: Rework activation
  activation:rework:2c45ad197b391190262c9c51aea07dfc8a14b36fa3488e86802af6a7c9429722;
  TURN implement epoch 4 attempt 2. Authoritative injected QA claim 1 failed on
  base 606fa72da22e4bf8cb556fd70c82a180621e8545; ancestry and first-hand-in
  exact AWAITING-QA bytes verified before write. Fix commit
  a86b33c658ef31e559374bea3ca9b215228fd6d8 replaces only line2 with
  FIXED-FOR-CLAIM 1; exact two-line LF cmp passes and patch against QA base is
  -AWAITING-QA / +FIXED-FOR-CLAIM 1. git diff --check passes. local-tests has no
  changed/direct tests or smoke set; lint exit 0 with 14 existing warnings.
  Adjacent queued/started/dead/superseded/retried/concurrent runtime paths and
  tests N/A because README forbids code and deployment for docs-only drill.
  e2e_529_exempt remains not_run and requires no repair. Required protocol
  progress/milestone updates only; prior spacing advisory corrected in new
  handoff text; approved design/SVG unchanged. Fresh main README blob
  c4a1b3334b84d73b95cf4e2943c2c8f1474aef87 on main
  ab48f15175b9514701de68993ca7991891eb5005; no pre_handin.script. PR 585 OPEN.
  Prior-head code review/CI/completion are historical; new-head effective
  review, CI ensure and needs_review receipt pending. No further commit after
  last milestone freeze except named review/CI fixes. No Linear, config, source,
  database, room deployment, QA dispatch, ship request or main push.
---

# FLY-3224 progress
**phase**: implement (3/4)
**next**: Update existing milestone as literal last commit, push, freeze final rework HEAD, update PR585, register fresh effective code review; after approval ensure CI and complete needs_review.

**handoff**: Rework activation activation:rework:2c45ad197b391190262c9c51aea07dfc8a14b36fa3488e86802af6a7c9429722; TURN implement epoch 4 attempt 2. Authoritative injected QA claim 1 failed on base 606fa72da22e4bf8cb556fd70c82a180621e8545; ancestry and first-hand-in exact AWAITING-QA bytes verified before write. Fix commit a86b33c658ef31e559374bea3ca9b215228fd6d8 replaces only line2 with FIXED-FOR-CLAIM 1; exact two-line LF cmp passes and patch against QA base is -AWAITING-QA / +FIXED-FOR-CLAIM 1. git diff --check passes. local-tests has no changed/direct tests or smoke set; lint exit 0 with 14 existing warnings. Adjacent queued/started/dead/superseded/retried/concurrent runtime paths and tests N/A because README forbids code and deployment for docs-only drill. e2e_529_exempt remains not_run and requires no repair. Required protocol progress/milestone updates only; prior spacing advisory corrected in new handoff text; approved design/SVG unchanged. Fresh main README blob c4a1b3334b84d73b95cf4e2943c2c8f1474aef87 on main ab48f15175b9514701de68993ca7991891eb5005; no pre_handin.script. PR 585 OPEN. Prior-head code review/CI/completion are historical; new-head effective review, CI ensure and needs_review receipt pending. No further commit after last milestone freeze except named review/CI fixes. No Linear, config, source, database, room deployment, QA dispatch, ship request or main push.
