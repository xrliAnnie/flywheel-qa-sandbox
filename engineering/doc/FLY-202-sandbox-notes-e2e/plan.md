# FLY-202 QA 沙箱 fixture 笔记 — 实施计划
Issue: FLY-202 (https://linear.app/geoforge3d/issue/FLY-202/qa-sandbox-fixture-slot-harness-real-runner-e2e-task-do-not-pick-up)
日期: 2026-09-26
基于: research.md

---

> **For the implement node:** Execute this plan task by task in the shared branch only while its injected TURN says `yours`. Do not dispatch another node; the DAG orchestrator owns advancement.

**Goal:** Keep `doc/qa/sandbox-notes.md` and open PR #194 as a truthful, repeatable real-Runner E2E fixture, changing content only when a current-state assertion fails.

**Architecture:** Treat tracked repository state and `packages/qa-framework/README.md` as sources of truth, derive four documentation sections from them, and bind the final committed branch SHA to PR #194. The happy path is intentionally idempotent: verification passes, the content file remains byte-identical, only the required progress ledger advances.

**Tech stack:** Git, GitHub CLI, POSIX shell/awk/diff, Markdown, Flywheel communication CLI.

## 1. Stable identities and write boundary

| Identity | Required value |
|---|---|
| Repository | `xrliAnnie/flywheel-qa-sandbox` |
| Branch | `project-slot-4-FLY-202` |
| Pull request | #194, OPEN, base=`main`, head=`project-slot-4-FLY-202` |
| Content file | `doc/qa/sandbox-notes.md` |
| Durable ledger | `engineering/doc/FLY-202-sandbox-notes-e2e/progress.md` |
| Preserved marker | final non-empty line `- FLY-2456 drill marker r1 B1` |

Allowed content change: `doc/qa/sandbox-notes.md` only. The injected progress command may update the ledger. Do not add, delete, rename, or move any file under `doc/`; do not touch packages, scripts, configuration, production databases, Discord, or Linear state. Do not create another PR, merge, rebase, force-push, request ship authority, or close PR #194.

## 2. Verification contract

| ID | Assertion | Pass condition |
|---|---|---|
| V1 | Purpose paragraphs | 2–3 blank-line-delimited prose blocks before `## Top-level directories` |
| V2 | Directory table | names equal `git ls-tree -d --name-only HEAD`; every description non-empty |
| V3 | README summary | 8–12 bullets (target 10) and no claim contradicts the current README |
| V4 | `doc/` listing | the unique `text` fence equals `ls -R doc/ \| head -50` byte-for-byte |
| V5 | Source truth | purpose and summary claims agree with README/scripts; alert isolation remains explicitly opt-in |
| V6 | Marker | last non-empty line equals the preserved FLY-2456 marker |
| V7 | Scope | no added/deleted path under `doc/`; content diff, if any, is only the allowed file |
| V8 | Hygiene | pre-commit and committed `git diff --check` both exit 0 |
| V9 | PR/SHA binding | PR is OPEN against main and local HEAD = remote branch SHA = PR head SHA |

## 3. Task 1 — Acquire authority and establish the baseline

**Files:** Read-only repository/PR state; no content writes.

- [ ] Run the exact injected `flywheel-comm turn` command. Continue only on `yours`; on `not-yours`, poll every 60–90 seconds without touching the worktree.
- [ ] Check the mailbox with the phase’s exact injected inbox command and act on any unread Lead instruction before continuing.
- [ ] Confirm the worktree starts clean except for state explicitly owned by the current node:

```bash
git status --short --branch
git branch --show-current
```

Expected branch: `project-slot-4-FLY-202`. Unexpected dirty files or another branch are a stop condition; report them instead of cleaning or overwriting them.

- [ ] Refresh remote metadata and classify divergence:

```bash
git fetch origin
git rev-list --left-right --count HEAD...origin/project-slot-4-FLY-202
```

Interpretation: `0 0` continues; `0 N` may use `git pull --ff-only`; `N 0` may continue only when every local commit belongs to the inherited DAG workflow; two non-zero numbers stop and report a fork. Never rebase or force-push.

- [ ] Capture the implementation baseline before any content edit:

```bash
git rev-parse HEAD | tee /private/tmp/flywheel-test-slot-4/tmp/FLY202-implement-base-sha
git diff --check
```

Record the full SHA in the eventual PR verification text. The implement node must use its own injected execution id, never the design execution id in this document history.

## 4. Task 2 — Run the content assertions before editing

**Files:** Read `doc/qa/sandbox-notes.md`, `packages/qa-framework/README.md`, `scripts/test-deploy.sh`, and `scripts/lead-alert.sh`.

- [ ] Verify V1 and V6:

```bash
awk 'BEGIN{in_body=0; paras=0; open=0} /^# Flywheel QA Sandbox Notes$/{in_body=1;next} /^## Top-level directories$/{if(open) paras++; print "purpose_paragraphs=" paras; exit} in_body {if($0 ~ /^[[:space:]]*$/){if(open){paras++; open=0}} else {open=1}}' doc/qa/sandbox-notes.md
awk 'NF{line=$0} END{print line}' doc/qa/sandbox-notes.md
```

Expected: `purpose_paragraphs=3` (2 is also valid) and the exact FLY-2456 marker.

- [ ] Verify V2 with Git’s tracked directory set, not local filesystem caches:

```bash
diff -u \
  <(git ls-tree -d --name-only HEAD | sort) \
  <(awk '/^## Top-level directories/{in_table=1;next} in_table && /^## /{exit} in_table && /^\| `/{name=$2; gsub(/`|\//,"",name); print name}' doc/qa/sandbox-notes.md | sort)
awk '/^## Top-level directories/{in_table=1;next} in_table && /^## /{exit} in_table && /^\| `/{count++; desc=$3; gsub(/^[[:space:]]+|[[:space:]]+$/,"",desc); if(desc=="") empty++} END{printf "rows=%d empty_descriptions=%d\n",count,empty+0}' FS='|' doc/qa/sandbox-notes.md
```

Expected at design time: diff exit 0, `rows=17 empty_descriptions=0`. A future tracked directory count may differ; equality, not the number 17, is authoritative.

- [ ] Verify V3:

```bash
awk '/^## `packages\/qa-framework\/README.md` summary/{in_summary=1;next} in_summary && /^## /{exit} in_summary && /^- /{count++} END{printf "summary_bullets=%d\n",count}' doc/qa/sandbox-notes.md
rg '^## ' packages/qa-framework/README.md
```

Expected at design time: 10 bullets. Read each bullet against the listed README sections; a count alone is insufficient.

- [ ] Verify V4 using a sandboxed temporary directory:

```bash
snapshot_dir=$(mktemp -d /private/tmp/flywheel-test-slot-4/tmp/FLY202-implement.XXXXXX)
awk '/^```text$/{in_block=1;next} in_block && /^```$/{exit} in_block{print}' doc/qa/sandbox-notes.md > "$snapshot_dir/expected"
ls -R doc/ | head -50 > "$snapshot_dir/actual"
diff -u "$snapshot_dir/expected" "$snapshot_dir/actual"
```

Expected: diff exit 0 and both files contain 50 lines. Leave the isolated temp directory for environment cleanup; do not use a broad recursive delete.

- [ ] Verify V5’s alert boundary with the actual sources:

```bash
sed -n '288,312p' packages/qa-framework/README.md
sed -n '128,162p' scripts/test-deploy.sh
sed -n '632,646p' scripts/test-deploy.sh
sed -n '356,372p' scripts/lead-alert.sh
```

The notes must say alert queue isolation requires `--alerts` plus a configured test alert channel; without it, production-default paths remain. Do not weaken this into an unconditional isolation claim.

- [ ] Record every V1–V6 result. If all pass, skip Task 3 and proceed to Task 4 without modifying `doc/qa/sandbox-notes.md`.

## 5. Task 3 — Repair only failed assertions

**Files:** Modify `doc/qa/sandbox-notes.md` only when Task 2 identifies a concrete failure.

- [ ] Before a literal replacement, copy the complete removed and added strings from the candidate diff and run `git grep -lF --` once for each literal. Record the exact commands, every match, and each exclusion reason; do not treat an empty result as permission for broad tests.

- [ ] Apply the narrowest repair:

  - V1: change paragraph breaks only until there are 2–3 prose blocks.
  - V2: add/remove only the table rows needed to equal the tracked directory set; inspect each new directory before writing its one-line description.
  - V3/V5: amend only contradicted bullets or claims after reading the corresponding source section.
  - V4: regenerate the fenced listing last, after all other edits.
  - V6: restore the inherited marker as the last non-empty line.

- [ ] Search for tests or consumers by full path, file name, and parent directory:

```bash
git grep -lF -- 'doc/qa/sandbox-notes.md'
git grep -lF -- 'sandbox-notes.md'
git grep -lF -- 'doc/qa'
```

Retain only concrete test files whose assertions consume this document. At design time no such test is known; generic parent-directory or fixture mentions must be recorded and excluded with a reason. Do not run bare Vitest, a package suite, a directory, or a glob. No `vitest related` is required unless the actual repair changes TypeScript.

- [ ] Re-run V1–V6 and check the candidate diff:

```bash
git diff --check
git diff --name-status
git diff --diff-filter=AD --name-only -- doc/
```

Expected: V1–V6 pass; no added/deleted `doc/` file; the only content modification is `doc/qa/sandbox-notes.md`.

- [ ] If the content changed, commit it without amending inherited history:

```bash
git add doc/qa/sandbox-notes.md
git commit -m "docs(FLY-202): refresh QA sandbox fixture notes"
```

If there was no drift, do not create an empty content commit.

## 6. Task 4 — Final ledger, push, and exact-SHA proof

**Files:** The injected progress command updates only `engineering/doc/FLY-202-sandbox-notes-e2e/progress.md`; PR metadata is updated through `gh` only after the final commit.

- [ ] Run the implement phase’s exact injected final `progress` command before pushing. This creates the last ledger commit; do not reuse `cd41d8e7-9d88-45e1-9921-4f0e91b42485`, which belongs to design.
- [ ] Re-run committed-scope checks after that ledger commit:

```bash
git diff --check origin/main...HEAD
git diff --diff-filter=AD --name-only "$(cat /private/tmp/flywheel-test-slot-4/tmp/FLY202-implement-base-sha)"..HEAD -- doc/
git status --short
```

Expected: clean worktree and no `doc/` addition/deletion from the final ledger commit.

- [ ] Push the branch fast-forward:

```bash
git push origin project-slot-4-FLY-202
```

Never use `--no-verify`; if rejected as non-fast-forward, stop and report rather than force-push.

- [ ] Prove V9 only after the push:

```bash
git rev-parse HEAD
git ls-remote origin refs/heads/project-slot-4-FLY-202
gh pr view 194 --json state,baseRefName,headRefName,headRefOid,url
```

Expected: state `OPEN`, base `main`, head `project-slot-4-FLY-202`, and all three full SHAs identical.

- [ ] Update PR #194’s body with the final execution id, baseline SHA, final SHA, V1–V9 results, exact-head CI status (or explicitly `pending`), and `Fixture only — do not merge`. Do not claim inherited-head CI as final-head CI.
- [ ] Check the mailbox once more, then use only the exact completion route injected into the implement phase. Do not dispatch QA, merge, or request ship authority.

## 7. Error handling and rollback

- Unexpected dirty files, branch divergence, a closed/misdirected PR, out-of-scope conflicts, unavailable source facts, or a non-fast-forward push are stop-and-report conditions. Preserve evidence; do not broaden scope to “fix” them.
- A content repair can be rolled back with `git revert` targeting the exact repair SHA recorded in that phase’s evidence. Do not rewrite history.
- PR body text may be corrected with another `gh pr edit`; PR #194 remains open and unmerged.
- If a post-push action creates another commit, repeat the push and V9 SHA proof. A prior SHA proof becomes stale immediately when HEAD moves.

## 8. QA evidence expected from the next phase

An independent QA node should reimplement V1–V9 rather than reuse implement scratch files, verify any retained concrete test one file at a time, and read exact-head PR CI. The passing design target is a truthful document and an open fixture PR—not a merge, deployment, production notification, or teardown.
