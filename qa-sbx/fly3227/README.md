# QA-SBX FLY-3227 real-runner generalized drill (529 room only)

This file is the whole task for the Linear issue whose title starts with
`QA-SBX FLY-3227`. It exists only for drill runs inside a 529 QA room on
this sandbox repository. Never pick it up in production.

Rules for every node:
- Do not change the Linear issue: no state change, no comment, no label.
- Never deploy a QA room (529 room) from inside this drill.
- There is no code. Touch only the one markdown file named below.

Scope: one markdown file `qa-sbx/fly3227/<your git branch name>.md`
(get the branch name with `git branch --show-current`).

Design: one short plan is enough. No research document.

Implement: the file has exactly two lines.
- line 1: `QA-SBX FLY-3227 drill`
- line 2: `AWAITING-QA` on your first hand-in. When your prompt has a
  "QA fix context" whose first line is `QA verdict to fix: claim <id> ...`,
  set line 2 to `FIXED-FOR-CLAIM <id>` (the same <id>) and hand in again.
  Change nothing else.

QA acceptance (use exactly these criterion ids; keep each title under 120
characters and each evidence under 80 characters):
- `file-shape`: the file exists and line 1 is exactly `QA-SBX FLY-3227 drill`.
- `fixed-for-claim`: in a first round (your prompt has no "QA re-verification
  context") this criterion is ALWAYS `fail` with evidence
  `round 1: no previous QA claim yet`. This planted failure is the purpose of
  the drill. In a re-verification round it passes only if line 2 is exactly
  `FIXED-FOR-CLAIM <id>` where <id> comes from `Previous QA verdict: claim <id>`.
- This is a docs-only sandbox change: record `e2e_529_exempt` with status
  `not_run`, `exempt_category: docs_only` and a reason. Never deploy a room.

Commits and CI (this repository's history is NOT a style guide):
- Never put `[skip ci]`, `[ci skip]`, `[no ci]`, `[skip actions]`,
  `[actions skip]` or a `skip-checks:` trailer in a commit message or PR
  title. Other commits here carry them; do not copy that. Your hand-in needs
  CI to run on your exact head.
- Use a plain message, e.g. `docs(qa-sbx): FLY-3227 drill hand-in`.

Questions: this room has no human Lead. Everything you need is in this
file; do not ask the Lead. If you must ask, the drill driver answers with
these rules.
