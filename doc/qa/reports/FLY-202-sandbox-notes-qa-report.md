# QA · FLY-202 — sandbox-notes fixture (Round 1 PASS / Round 2 FAIL / Round 3 PASS — fix-loop E2E)

**Issue**: FLY-202 (QA sandbox fixture — slot harness real-Runner E2E task, do not pick up)
**Gates**: FLY-202 Implement phase — `doc/qa/sandbox-notes.md` deliverable + PR #49
**PR head (Round 1)**: `2d5e267380a0f06521be86fb5be60f2cbc64b1b4` (branch `project-slot-2-FLY-202`, local HEAD == `origin/project-slot-2-FLY-202` == PR #49 head — verified via `git fetch` + `git rev-parse`)
**PR head (Round 3, post-fix)**: `ec66fadb91d8ecbc64b6aaf50aeb00d88058a11b`
**Date**: 2026-07-06
**Round 1 Verdict**: **PASS** — deliverable matched the design-phase plan exactly; all structural invariants held against the live repo (not a stale snapshot). See "Verification results" below.
**Round 2 Verdict**: **FAIL (deliberate)** — see "Round 2" section. This round exercises the FLY-887 keep-alive QA fix-loop mechanism end-to-end: a real, tiny, deliberately-introduced defect was committed on top of the Round 1 PASS state, specifically so a re-test wake can be observed fixing it and re-verifying to a fresh PASS.
**Round 3 Verdict**: **PASS** — see "Round 3" section. RE-TEST wake received, Implement phase pushed a one-line fix (commit `ec66fad`), `verify.sh` re-run at the new head reports all 5 checks green again. Fix-loop cycle closed.

## Scope

Verified the Implement phase's single deliverable, `doc/qa/sandbox-notes.md`, against the plan
(`doc/qa/FLY-202-sandbox-notes/plan.md`) and its own Verification Summary. Did not re-implement
or modify the deliverable's content — this is a doc-only fixture change with no runtime surface
(per plan §Architecture: "TDD 豁免", D4/D5 gate), so QA here means (a) confirming the plan's
own structural checklist actually holds against **current** repo state, not the values that were
true when the plan was written, and (b) turning that one-off checklist into a repeatable,
committed script so a future re-run of this fixture (or a stale-content regression) can be
caught mechanically instead of by eyeball.

## Verification results

### 1. All 4 required sections present — PASS

`grep -c '^## ' doc/qa/sandbox-notes.md` → `4` (repo purpose, top-level directory table,
qa-framework README summary, `ls -R doc/ | head -50` snapshot).

### 2. Directory table is complete and accurate — PASS

Live `ls -F | grep -c '/$'` → **11** top-level directories; table row count
(`grep -c '^| \`'`) → **11** — exact match. Spot-checked table content against live directory
contents (not just count):

| Directory | Table description | Live contents check |
|---|---|---|
| `engineering/` | "Engineering department doc-flow area (engineering/doc/...)" | `ls engineering/` → `doc` ✓ |
| `fleet/` | "Fleet configuration example (README + example)" | `ls fleet/` → `README.md`, `example` ✓ |

Every listed directory name (`agents doc docs engineering fleet packages patches qa-fly294
qa-fly310 scripts supabase`) matches the live `ls -F` enumeration 1:1; no directory is missing
or invented.

### 3. `packages/qa-framework/README.md` summary — PASS

Read the full 317-line README and checked each of the 10 embedded bullets against it
line-by-line: architecture (2-layer), quick start, 5-step protocol, Test Slot Framework
(FLY-96/FLY-115) + its 3 scripts, pre-requisites incl. `FLYWHEEL_RUNNER_START_POINT`, FLY-60
hard-gate suite, Mirror Mode (FLY-153) scope note, Roundtable/Alert Mirrors (FLY-529), and
Contracts — all 10 bullets are accurate summaries with no fabricated claims. Bullet count = 10,
within the plan's required 9–11 range.

### 4. `ls -R doc/ | head -50` snapshot is verbatim and **current** — PASS

This is the check most likely to silently rot (the plan explicitly warns against copying a
stale snapshot). Ran `diff <(ls -R doc/ | head -50) <(embedded fenced block content)` →
**zero diff**. The embedded snapshot is byte-for-byte what the live repo produces right now,
not a value carried over from an earlier design-time run.

### 5. Fenced code block well-formed — PASS

`awk '/^## \`ls -R/,0' ... | grep -c '^\`\`\`'` → `2` (one open, one close fence, nothing
unterminated).

### 6. PR / branch state consistency — PASS

`git fetch origin project-slot-2-FLY-202` then `git rev-parse HEAD` vs
`git rev-parse origin/project-slot-2-FLY-202` → identical
(`2d5e267380a0f06521be86fb5be60f2cbc64b1b4`). `gh pr view --json ...` confirms PR #49 is OPEN,
head `project-slot-2-FLY-202` → base `qa-e2e-887-scratch` on `xrliAnnie/flywheel-qa-sandbox`
(sandbox repo only — no production resources touched). No second PR was opened by this QA pass.

## Test coverage added

The plan's Verification Summary was a manual checklist of ad hoc shell one-liners run once at
Task 5. Codified it as an executable regression check:

- **Added**: `doc/qa/FLY-202-sandbox-notes/verify.sh` — runs all 5 checks above (4 structural +
  the verbatim `ls -R` freshness diff) and exits non-zero on any failure.
- **Verified the check has teeth** (not just always-PASS): ran it against a deliberately
  corrupted copy (mismatched fence count) in `/tmp` — script correctly reported
  `FAIL: fenced ls -R block open+close (expected 2, got 1)` and exit code 1. Original file was
  restored and confirmed byte-identical via `git status --short` (no diff) before commit.
- Real run against the actual `doc/qa/sandbox-notes.md` on this branch: **exit 0, all 5 PASS**
  (see full output below).

```
$ ./doc/qa/FLY-202-sandbox-notes/verify.sh
PASS: 4 sections present (4)
PASS: table rows == live top-level dir count (11)
PASS: README summary bullet count in [9,11] (10)
PASS: fenced ls -R block open+close (2)
PASS: embedded ls -R snapshot matches live output verbatim
ALL CHECKS PASSED
```

## Out of scope / not touched

- Did not modify `doc/qa/sandbox-notes.md` content — it was already correct.
- Did not touch any other file in `doc/qa/FLY-202-sandbox-notes/` (exploration/research/plan
  left as the Design phase wrote them).
- Did not open a second PR — pushed onto the existing branch, updating PR #49 in place.
- No production Flywheel repo, Bridge, or Discord channel was touched; all verification ran
  inside the sandbox clone at `/private/tmp/flywheel-test-slot-2/project-slot-2-FLY-202`.

## Conclusion (Round 1)

The Implement phase's `doc/qa/sandbox-notes.md` deliverable is correct, complete, and current
against live repo state — all 4 plan-mandated sections present, directory table and README
summary both spot-checked for factual accuracy (not just count), and the `ls -R` snapshot is
verbatim-fresh rather than a stale copy. Added a committed, repeatable verification script so
future re-runs of this fixture (or accidental content drift) fail loudly instead of silently.

## Round 2 — deliberate regression (FLY-887 keep-alive fix-loop E2E)

**Purpose**: per explicit instruction from the team lead, this round exercises the real
FAIL → wake → fix → re-test → PASS loop on a real-machine test slot, using this already-PASSing
fixture as the vehicle. One tiny, real defect was deliberately introduced (not fabricated as a
false claim — the file content genuinely no longer matches the live repo) and reported as a
genuine FAIL, exactly as `verify.sh` would report it if a future Implement-phase edit introduced
this same regression by accident.

**Defect introduced**: removed the `qa-fly310/` row from the "Top-level directories" table in
`doc/qa/sandbox-notes.md` (previously line 36). No other content changed.

**Expected vs. actual**:
- Expected: table row count == live top-level directory count == **11**.
- Actual: table now has **10** rows (missing `qa-fly310/`); live top-level directory count is
  still 11 (`ls -F | grep -c '/$'` → 11, dir still exists on disk, untouched).

**Reproduction** — `./doc/qa/FLY-202-sandbox-notes/verify.sh`:

```
PASS: 4 sections present (4)
FAIL: table rows == live top-level dir count (expected 11, got 10)
PASS: README summary bullet count in [9,11] (10)
PASS: fenced ls -R block open+close (2)
PASS: embedded ls -R snapshot matches live output verbatim
SOME CHECKS FAILED
```

Exactly one check fails, isolating the defect precisely to the directory table (all other
sections remain correct) — confirming the check has real discriminating power, not a blanket
failure.

**Fix required**: re-add the `qa-fly310/` row (`| \`qa-fly310/\` | Historical QA evidence/E2E
scripts for FLY-310 |`) immediately after the `qa-fly294/` row, restoring 11 table rows to match
the 11 live top-level directories.

**Round 2 verdict**: **FAIL**. Not shipping this head. Reporting via `qa-result --status fail`
and parking to await the RE-TEST wake once the Implement phase pushes the fix.

## Round 3 — RE-TEST after fix (fix-loop E2E, continued)

Woken by a RE-TEST signal reporting the Implement phase pushed a fix and the worktree was
already at the new head — no fetch/checkout needed (same directory, shared branch).

1. `flywheel-comm turn --exec-id c6280f4b-f3b6-4778-a251-667e50160eed` → `yours phase=qa epoch=5`
   before touching anything, per the single-writer protocol.
2. Confirmed the new head: `git rev-parse HEAD` → `ec66fadb91d8ecbc64b6aaf50aeb00d88058a11b`,
   matching the wake notification exactly.
3. Inspected the fix commit (`ec66fad "docs(FLY-202): re-add qa-fly310 dir row — QA fix-loop
   round 1"`): a single-line diff (`doc/qa/sandbox-notes.md | 1 +`) that re-adds exactly the
   `qa-fly310/` row removed in Round 2 — no unrelated changes, no scope creep.
4. Re-ran `./doc/qa/FLY-202-sandbox-notes/verify.sh`:

```
PASS: 4 sections present (4)
PASS: table rows == live top-level dir count (11)
PASS: README summary bullet count in [9,11] (10)
PASS: fenced ls -R block open+close (2)
PASS: embedded ls -R snapshot matches live output verbatim
ALL CHECKS PASSED
```

All 5 checks green, including the one that failed in Round 2 (table rows now back to 11/11).

**Round 3 verdict**: **PASS**. Fix confirmed correct and minimal. Fix-loop E2E cycle
(PASS → deliberate FAIL → wake → fix → RE-TEST → PASS) exercised successfully end-to-end.
Reporting via `qa-result --status pass`.
