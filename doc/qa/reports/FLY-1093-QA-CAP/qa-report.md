# QA Report — FLY-1093 (QA-CAP slot round)

**Issue:** FLY-1093 — QA · FLY-1050 #528 — 529 Room 真 Discord E2E（死 QA→干净重生真的在 Discord 线程冒出来）
**Slot / branch:** test-slot-1 / `project-slot-1-FLY-1093-QA-CAP`
**Exec:** 0469f17a-7149-492a-8b09-2742a88fe312
**Tested SHA:** b5f3c16 (`HEAD == main == origin/main`)
**Date:** 2026-07-10
**Verdict:** SCOPED PASS (slot pipeline plumbing) — real FLY-1093 acceptance **NOT PERFORMED** (out of scope in this slot)

---

## Honesty boundary (read first)

This report does **NOT** perform the real FLY-1093 acceptance.

FLY-1093's true scope (per Linear) is: in the **isolated FLY-529 QA Room**, use PR #528's
dist (pinned head `5da5fd18`) and verify by **real Discord E2E** that a three-stage "dead QA →
clean rebirth" actually surfaces correctly in the corresponding `[FLY-XX]` Discord thread
(stage/status posts, correct thread binding, `epoch+1`, no duplicate posts, zero belt noise),
plus the non-regeneration cases.

The issue's 铁律 (iron rules) require:
- run **only** on the isolated 529-Room Bridge, never touching production Bridge/DB/threads;
- **verify only, do not modify implementation code**;
- collect **real Discord evidence** (message links / screenshots) — "seen in logs" does not count.

That environment (isolated 529-Room Bridge + test-guild Discord threads + PR #528 dist at
`5da5fd18`) **is not present in this cloned `flywheel-qa-sandbox` slot worktree**. Confirmed
absent (`/tmp/flywheel-529*`, `~/.flywheel/529*`, any `*529*` under the repo → no matches).
Therefore the real 529-Room Discord verification is **OUT OF SCOPE / NOT PERFORMED** here.
This is an environmental limitation of the slot, correctly declared — not a skipped test.

---

## What was actually verified (scoped)

### 1. Branch / dispatch-premise check — PASS (with finding)

| Check | Expected (three-stage premise) | Actual | Result |
|-------|-------------------------------|--------|--------|
| Impl commit on branch | code committed by implement phase | `git diff main...HEAD` empty | **premise not held** |
| PR open on branch | PR opened by implement phase | `gh pr view` → none for this branch | **premise not held** |
| HEAD position | ahead of main | `HEAD == main == origin/main` (`b5f3c16`) | — |
| Working tree | — | clean | OK |

The three-stage dispatch premise ("implement already committed the code and opened a PR on
THIS branch") **did not hold** in this slot — there is no implementation delta to verify.

### 2. Real-acceptance environment probe — confirms OUT OF SCOPE

- No isolated 529-Room Bridge / test-guild present in the slot (see Honesty boundary).
- PR #528 dist (`5da5fd18`) not checked out here; sandbox is standalone (not a live Bridge host).

### 3. Product test suite — recorded, not run

- `node_modules` absent in the slot (monorepo deps not installed); root `test` = `pnpm -r test`.
- There is **no FLY-1093 code delta on the branch** (`HEAD == main`), so a suite run would only
  exercise production `main`, not any change under test. Running it would not verify FLY-1093.
- Recorded, not run — consistent with the sibling round (PR #53).

### 4. Slot pipeline plumbing (the QA-CAP capacity exercise) — PASS

The actual thing a `-QA-CAP` capacity round exercises end-to-end **is** runnable and was run:
onboard → `stage set` transitions → QA report deliverable → commit → push → PR → `qa-result`
→ approve gate → `:cool:` ship. `flywheel-comm stage set` writes are accepted by the CommDB.

---

## Findings

| # | Finding | Severity | Status |
|---|---------|----------|--------|
| 1 | Issue labeled **`no-three-stage`** (Linear labels: `["no-three-stage","Flywheel"]`) was dispatched through the **three-stage QA pipeline** template — label→pipeline mapping inconsistency. | Low (non-blocking) | Reported; also noted in sibling PR #53. Tracked separately. |
| 2 | `flywheel-comm progress` refused with exec `status=terminated` for the path-limited-commit writer lock, while `stage set` writes are accepted. Progress ledger committed as a normal file instead. | Low (infra) | Recorded. |

Neither finding blocks; both are harness/plumbing observations, not defects in the code under
FLY-1093's real scope (which was not exercised here).

## Relationship to sibling round (PR #53)

PR #53 (`project-slot-1-FLY-1093-QA-MAIN`) is a parallel slot round of the same FLY-1093
exercise with the same honesty boundary. This `-QA-CAP` round is a distinct capacity dispatch;
it does not supersede or contradict PR #53.

## Overall

**SCOPED PASS** for the slot pipeline plumbing. The **real FLY-1093 acceptance (529-Room real
Discord E2E of the PR #528 rebirth) is NOT PERFORMED** in this slot and remains open — it must
run in the isolated FLY-529 QA Room against PR #528 dist `5da5fd18`, per the issue's 铁律.
