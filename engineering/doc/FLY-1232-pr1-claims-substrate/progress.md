---
issue: FLY-1232
phase: qa
phaseCursor: 1/1
updated: 2026-07-14T07:40:00.000Z
nextStep: "earn codex review record @ final head → open founder approve_to_ship gate → report Lead"
chunks: []
pointers: {}
---

# FLY-1232 progress
**phase**: qa (final verification on the final head 9e37006f7) — VERDICT: PASS
**next**: earn codex review record @ final head → open founder approve_to_ship gate → report Lead

QA FINAL VERIFICATION (Lead 67225a60, on final head 9e37006f7):
- ① turn self-check yours (epoch 5).
- ② spot-check: rebase preserved my 3 QA commits + substrate semantics — 6 focused
  workflow suites (121 tests) + probe + truth-table drill all green on the final head;
  the 2 rebase conflict repairs (post-ship-finalization markIssueDone dedup + wiring-test
  ctor arity) do NOT touch claims/shadow semantics. Drill conclusion (25/25) carries.
- ③ B11 fresh-spawn: new bridge/__tests__/workflow-b11-freshspawn.test.ts (2 green) drives
  the REAL RunDispatcher.start() SEAM (Blueprint.run + TmuxAdapter are stood in for by a
  test callback that performs the FLY-245 commit-gate adapter's marker-write + CommDB
  registration) — real marker file + real better-sqlite3 CommDB; reconcileSideEffects reads
  both real facts → started; start-success alone does not fabricate started; no-writer keeps
  launchCommitPath undefined. Scope ruled A by Lead (2b3a46ed): VERIFIED = FLY-1232's new
  fresh-path launchCommitPath propagation; INHERITED = FLY-245 adapter marker-write (shipped);
  DEFERRED-to-enable-gate = full real tmux spawn (pinned into Linear closeout + sub-issue B).
  qa-report B11 = PASS for the default-off merge (§4.2 three-tier boundary).
- ④/⑤ next: earn the codex code-review record at this head, then open the founder gate.

Belt history: implement 8/8 → QA (independent) ran on PR #578 and reported PASS
with an R5-folded drill → branch went CONFLICTING vs main (#564/#580/#581) → QA
filed the conflict as a finding and routed rework → belt back to implement
(epoch=4, Lead hand-flipped; Bridge rework flip path missing — noted by Lead).

Implement (rework lap) done so far:
- rebased 33 commits onto origin/main ac625b1b9; repaired 2 semantic conflicts
  (duplicated pre-#564 markIssueDone in post-ship-finalization; RunDispatcher
  ctor arity in the wiring test); preserved QA's 3 commits by cherry-pick
  (acceptance probe / flag-ON drill / R5 fold). PR #578 MERGEABLE again.
- focused tests green post-rebase: claims 43 / doc-sentinel 3 / shadow 27 /
  shadow-writer 32 / wiring 9 / post-ship 20 / probe 7 + orchestrator+dispatcher
  187 + TmuxAdapter 108; build + biome clean; CI green on ec39bd002.
- Codex R6 (post-rebase incremental) folded: B6 probe now reopens the SAME
  on-disk file and replays a clean batch (real-file end to end, mutation-checked);
  qa-report.md counts/evidence reconciled.
- **QA verdict status (honest, Codex R6/R7 HIGH)**: the earlier QA PASS holds for
  the code-audit + unit + truth-table-drill scope, BUT **B11's fresh-spawn clause
  is UNVERIFIED** — the drill calls writer hooks directly (hand-written marker,
  in-memory CommDB-row fact) and does not drive RunDispatcher.start → Blueprint →
  adapter → launchCommitPath → real CommDB registration. qa-report.md B11 is now
  PARTIAL; the drill header carries an explicit SCOPE block. **Do NOT route to
  ship on this ledger alone**: QA's final real-machine verification on the final
  head (Lead-scheduled, incl. a real fresh spawn for B11) is the closing gate,
  then the founder approve gate.
- Codex rounds: R1–R3 (implement) + R5 (QA delta) + R6/R7 (post-rebase) —
  R7 confirmed the R6 folds sound; its one remaining HIGH was THIS ledger's
  stale "QA PASS / route to ship" claim, fixed by this revision.
