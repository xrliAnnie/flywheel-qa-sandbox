---
issue: FLY-1257
phase: implement
phaseCursor: 1/1
updated: 2026-07-15T21:30:00.000Z
nextStep: fold the zombie-Z1 review-gate exemption (Codex R5 HIGH), then re-run codex review
chunks: []
pointers: {}
---

# FLY-1257 progress — DURABLE HANDOFF (Tadashi a42168b0: option A = fold into #599)

## State
- PR #599, branch `flywheel-FLY-1257` on origin, last pushed head **69e0bed07** (this branch tip). CI Build & Test PASS at that head; MERGEABLE/CLEAN.
- Defects ①②③④ fixed. Codex review APPROVED path-2 + merge resolution + HIGH-1; it keeps finding one MORE review-gate-retirement path each round.
- `codex_review_record` = **0 rows**; `.flywheel/runs/48ec5022-23db-4be2-93a5-e22125713cf9/codex/code-review.json` does NOT exist. Nothing faked.

## REMAINING WORK — Codex R5 HIGH (Tadashi confirmed: fold into #599)
**Finding:** the HIGH-2 fix (finalizeSession exempts review gates) is INCOMPLETE. finalizeSession spares the review gate but still DELETES the session row → next zombie-gate-hygiene patrol sees `from_agent` session as **missing** → the chronology guard (`if (session) {...}`) is skipped → the gate falls through to Z1 and is retired via `retireQuestionGuarded`. The kill just moved from finalizeSession to zombie-hygiene.

**Convergence proof (this is the LAST path):** every gate-retirement site that can touch a review gate —
- GatePoller eviction (path-2) — FIXED (isReviewGateCheckpoint exemption, gate-poller.ts).
- finalizeSession (commdb-fsm-reconcile + commdb-session-prune) — FIXED (SQL `checkpoint NOT IN ('review_design','review_code')`, db.ts).
- **zombie-hygiene Z1 → retireQuestionGuarded — THE ONE STILL UNFIXED.**
- retireShipGate (plugin.ts:5262 / event-route.ts:1186 / gate-poller.ts:2080) — structurally review-safe (WHERE `checkpoint='approve_to_ship'`); cannot touch a review gate.
- CommDB TTL purge — the intended 72h bound, not a bug.
Exempt Z1 → defect ④ complete.

## EXACT FIX (isomorphic to path-2 / HIGH-2)
`packages/teamlead/src/bridge/zombie-gate-hygiene.ts`:
- Use `isReviewGateCheckpoint` (exported from `./gate-poller`; check for an import cycle — if any, inline a local `review_design`/`review_code` set).
- BEFORE the chronology `if (session) {...}` block (~line 145): `if (isReviewGateCheckpoint(q.checkpoint)) continue;` — a review gate is unconditionally protected from Z1 (author's teardown/missing-session never retires it).

## TESTS (each mutation-verified — remove the guard → its test goes red)
`packages/teamlead/src/bridge/__tests__/zombie-gate-watchdog.test.ts`:
- `chronologyHarness` (~line 198) inserts its gate as **`review_code`** (line 217). With the Z1 exemption the existing "gate created before terminal entry remains a true Z1 zombie" test (~line 235) breaks — the review gate is now protected. REWORK: switch the harness's checkpoint to a NON-review one (e.g. `brainstorm`) so it still tests created_at-vs-terminal_at, AND add: a `review_code`/`review_design` gate is NEVER retired by Z1 regardless of chronology (pre-terminal, post-terminal, AND missing-session — missing-session is the actual R5 scenario).
- Add the finalize→zombie combined regression: finalizeSession spares the review gate + deletes the row → a subsequent zombie-hygiene pass does NOT retire it.

## THEN (sequence)
focused suites + typecheck + lint green → push (head advances) → wait CI green at NEW head → foreground codex re-review (`codex-companion.mjs task --write --effort xhigh --resume-last`, NO --background; cancel stale job via `codex-companion.mjs cancel <id>` first) binding NEW head → APPROVED writes code-review.json → `flywheel-comm await-codex-gate code` lands codex_review_record → report flywheel-eng-lead → he executor-merges. Keep session `running` (non-terminal). Never self-merge/self-ship.

## Gotchas
- Local vitest gets 9 spurious fails from `~/.flywheel/.env` `FLYWHEEL_RUNNER_BACKEND=codex` leaking in — run with `env -u FLYWHEEL_RUNNER_BACKEND`. CI is clean.
- Rebuild `flywheel-comm` dist (`tsc`) after editing its source; plugin.ts imports the dist.
- Keep local HEAD == PR head before each codex review (gate fail-closes on `reviewedHeadSha !== git rev-parse HEAD`).
- companion `task` runs FOREGROUND when `--background` omitted; a `--background` job dies at spawn ("starting", zero progress) — always run foreground.
