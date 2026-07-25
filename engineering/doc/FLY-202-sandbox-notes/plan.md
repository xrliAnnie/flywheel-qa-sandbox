# FLY-202 Sandbox Notes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create a source-accurate `doc/qa/sandbox-notes.md` that satisfies every FLY-202 fixture requirement and can be validated deterministically.

**Architecture:** This is a documentation-only change. The requested note is derived directly from the current worktree: Git supplies the complete top-level directory set, the QA framework README supplies the summary, and the prescribed `ls` pipeline supplies the fenced evidence block. A shell requirements check provides the RED→GREEN proof without adding production code.

**Tech Stack:** Markdown, POSIX shell utilities, Git, GitHub CLI

---

### Task 1: Establish the RED documentation check

**Files:**
- Target missing before GREEN: `doc/qa/sandbox-notes.md`

- [ ] **Step 1: Run the requirements check before creating the document**

```bash
bash -euo pipefail -c '
target=doc/qa/sandbox-notes.md
test -f "$target"
test "$(awk "/^## Purpose/{inside=1;next}/^## /{inside=0} inside && NF{if (\$0 !~ /^[-*#|`]/) n++} END{print n+0}" "$target")" -ge 3
for dir in $(git ls-tree -d --name-only HEAD); do
  grep -Fq "| \`$dir/\` |" "$target"
done
test "$(awk "/^## packages\\/qa-framework\\/README.md Summary/{inside=1;next}/^## /{inside=0} inside && /^- /{n++} END{print n+0}" "$target")" -eq 10
ls -R doc/ | head -50 > /tmp/fly-202-doc-tree.actual
awk "/^## \`ls -R doc\\/ \\| head -50\` Output/{inside=1;next} inside && /^```/{if (open) exit; open=1; next} inside && open{print}" "$target" > /tmp/fly-202-doc-tree.documented
cmp /tmp/fly-202-doc-tree.actual /tmp/fly-202-doc-tree.documented
'
```

Expected: FAIL at `test -f` because `doc/qa/sandbox-notes.md` does not yet exist.

### Task 2: Create the sandbox note

**Files:**
- Create: `doc/qa/sandbox-notes.md`

- [ ] **Step 1: Write the purpose narrative**

Create a title plus date metadata and three prose paragraphs:

1. Explain that `flywheel-qa-sandbox` is the isolated repository where test-slot real-Runner branches, commits, PRs, CI, and merge effects are allowed to land without touching production.
2. Explain the concrete lifecycle: `test-deploy.sh` creates an isolated slot with a test Bridge and Lead, `inject-linear-issue.sh` calls `POST /api/runs/start`, and `test-teardown.sh` cleans processes, worktrees, temporary files, and CommDB state.
3. Explain that FLY-202 is a stable PreHydrator-visible Linear fixture designed to create an observable mid-work window and must not be picked up by production Leads or Runners.

- [ ] **Step 2: Add the complete top-level directory table**

Add exactly one row for every output line from:

```bash
git ls-tree -d --name-only HEAD
```

The table must cover:

```text
.claude
.flywheel
.github
.lead
.serena
agents
doc
docs
engineering
fleet
menus
packages
patches
product
qa-fly294
qa-fly310
scripts
supabase
vendor
```

Each row must describe the directory’s observed contents in one concise sentence.

- [ ] **Step 3: Add ten QA framework summary bullets**

Summarize `packages/qa-framework/README.md` in exactly ten bullets covering:

1. reusable plan-aware QA framework and its two-layer architecture;
2. Quick Start plus the five-step protocol;
3. real-Runner test-slot lifecycle and the no-synthetic-mode rule;
4. prerequisites and `FLYWHEEL_RUNNER_START_POINT`;
5. FLY-60 hard-gate suite and its evidence boundaries;
6. FLY-153 Mirror Mode;
7. FLY-529 Roundtable and Alert mirrors;
8. FLY-1389 cold-Lead knobs and bridge-only deploys;
9. sandbox token accounting and auto-QA being off by default;
10. plan-source and skill-interface contracts.

- [ ] **Step 4: Append the exact command output**

Run:

```bash
ls -R doc/ | head -50
```

Copy all 50 output lines verbatim under `## \`ls -R doc/ | head -50\` Output` in a fenced `text` block.

### Task 3: Verify GREEN and commit

**Files:**
- Verify: `doc/qa/sandbox-notes.md`
- Verify: `engineering/doc/FLY-202-sandbox-notes/exploration.md`
- Verify: `engineering/doc/FLY-202-sandbox-notes/plan.md`

- [ ] **Step 1: Re-run the complete requirements check**

Run the exact shell block from Task 1.

Expected: exit 0 with no output.

- [ ] **Step 2: Check Markdown diff hygiene**

```bash
git diff --check
git diff --stat
```

Expected: no whitespace errors; the diff contains the requested note plus process documentation and progress ledger.

- [ ] **Step 3: Inspect the final deliverable**

```bash
sed -n '1,260p' doc/qa/sandbox-notes.md
```

Expected: three purpose paragraphs, 19 directory rows, ten summary bullets, and the exact 50-line command output.

- [ ] **Step 4: Commit the implementation**

```bash
git add doc/qa/sandbox-notes.md
git commit -m "docs(FLY-202): add QA sandbox fixture notes"
```

Expected: one documentation commit containing the requested deliverable.

### Task 4: Publish and enter the Flywheel landing flow

**Files:**
- Update through CLI only: `engineering/doc/FLY-202-sandbox-notes/progress.md`
- Write through landing workflow: `.flywheel/runs/a7a4eec4-b7a9-4974-8679-f6d4d1f09f55/land-status.json`

- [ ] **Step 1: Push the existing harness-created feature branch**

```bash
git push -u origin project-slot-2-FLY-202
```

- [ ] **Step 2: Open a PR against sandbox `main`**

```bash
gh pr create \
  --base main \
  --head project-slot-2-FLY-202 \
  --title "docs(FLY-202): add QA sandbox fixture notes" \
  --body $'## Summary\n- describe the QA sandbox and slot lifecycle\n- inventory every top-level directory\n- summarize the QA framework and capture the requested tree output\n\n## Verification\n- deterministic documentation requirements check\n- git diff --check'
```

- [ ] **Step 3: Complete mandatory review and approval controls**

Resolve the PR identity:

```bash
PR_URL=$(gh pr view --json url -q '.url')
PR_NUMBER=$(gh pr view --json number -q '.number')
```

Register and poll the request-driven cross-family code review:

```bash
CODE_Q=$(node /Users/xiaorongli/Dev/flywheel-FLY-1466/packages/flywheel-comm/dist/index.js gate review_code \
  --lead flywheel-test-2 \
  --exec-id a7a4eec4-b7a9-4974-8679-f6d4d1f09f55 \
  --no-block "Code review requested: PR $PR_URL" | jq -r '.questionId')
node /Users/xiaorongli/Dev/flywheel-FLY-1466/packages/flywheel-comm/dist/index.js request-review \
  --type code \
  --question-id "$CODE_Q"
node /Users/xiaorongli/Dev/flywheel-FLY-1466/packages/flywheel-comm/dist/index.js check "$CODE_Q"
```

After an APPROVED or governance-level SKIPPED verdict, probe CI and bind the approval gate:

```bash
gh pr checks "$PR_NUMBER"
APPROVE_Q=$(node /Users/xiaorongli/Dev/flywheel-FLY-1466/packages/flywheel-comm/dist/index.js gate approve_to_ship \
  --lead flywheel-test-2 \
  --exec-id a7a4eec4-b7a9-4974-8679-f6d4d1f09f55 \
  --timeout 14400000 \
  --timeout-behavior fail-close \
  --no-block "PR created: $PR_URL. Ready for review." | jq -r '.questionId')
node /Users/xiaorongli/Dev/flywheel-FLY-1466/packages/flywheel-comm/dist/index.js complete \
  --route needs_review \
  --pr "$PR_NUMBER" \
  --question-id "$APPROVE_Q"
node /Users/xiaorongli/Dev/flywheel-FLY-1466/packages/flywheel-comm/dist/index.js verify-approval \
  --exec-id a7a4eec4-b7a9-4974-8679-f6d4d1f09f55 \
  --pr-head "$(git rev-parse HEAD)"
```

- [ ] **Step 4: Ship only through the project workflow**

After verified approval, post `:cool:`, wait for the deploy workflow to merge, then write the merged commit SHA to the required landing signal:

```bash
node /Users/xiaorongli/Dev/flywheel-FLY-1466/packages/flywheel-comm/dist/index.js stage set ship
gh pr comment "$PR_NUMBER" --body ":cool:"
gh pr view "$PR_NUMBER" --json state,mergeCommit
```

Only after the state is `MERGED`, write the actual PR number and merge SHA to the required signal, then complete the stage:

```bash
LAND_PATH=/tmp/flywheel-test-slot-2/project-slot-2-FLY-202/.flywheel/runs/a7a4eec4-b7a9-4974-8679-f6d4d1f09f55/land-status.json
MERGE_SHA=$(gh pr view "$PR_NUMBER" --json mergeCommit -q '.mergeCommit.oid')
mkdir -p "$(dirname "$LAND_PATH")"
jq -n \
  --arg sha "$MERGE_SHA" \
  --argjson n "$PR_NUMBER" \
  '{status:"merged",prNumber:$n,mergeCommitSha:$sha}' > "$LAND_PATH"
node /Users/xiaorongli/Dev/flywheel-FLY-1466/packages/flywheel-comm/dist/index.js stage set completed
```
