---
allowed-tools:
  - Bash(gh pr:*)
  - Bash(gh run:*)
  - Bash(gh api:*)
  - Bash(git diff:*)
  - Bash(git log:*)
  - Bash(git add:*)
  - Bash(git commit:*)
  - Bash(git push:*)
  - Bash(git mv:*)
  - Bash(git status:*)
  - Bash(git -C:*)
  - Bash(git checkout:*)
  - Bash(pnpm lint:*)
  - Bash(pnpm format:*)
  - Bash(pnpm build:*)
  - Bash(pnpm typecheck:*)
  - Bash(pnpm test:*)
  - Bash(sleep:*)
  - Bash(find doc/:*)
  - Bash(ls doc/:*)
description: "Ship PR — CI green gate, fix loop, archive docs, merge"
---

# Ship PR — Flywheel

CI green gate + fix loop + pre-merge archive + squash merge for Flywheel PRs.

**Usage**: `/ship-pr [<pr-number>] [--yes]`

- `<pr-number>`: Specify PR directly (optional — will infer from current branch)
- `--yes`: Skip confirmation, execute immediately (for orchestrator worker mode)

## Phase 0: Identify the PR

### 0a. Determine PR Number
1. If `<pr-number>` argument provided, use it directly
2. Otherwise, check current branch for an associated open PR:
   ```bash
   gh pr view --json number,title,headRefName -q '.number' 2>/dev/null
   ```
3. If no current branch PR, check session context (what was just worked on)
4. Fallback: `gh pr list --limit 5` and pick the most likely candidate

### 0b. Confirm (unless --yes)
If `--yes` is NOT set, present PR info and wait for confirmation:
"Shipping PR #{number} — {title} (`{branch}`). Proceed?"

### 0c. Metadata Hydration
Extract variables needed by subsequent phases:
```bash
PR_NUMBER={from 0a}
HEAD_BRANCH=$(gh pr view ${PR_NUMBER} --json headRefName -q '.headRefName')
ISSUE_ID=$(echo "$HEAD_BRANCH" | grep -oE '(GEO|FLY)-[0-9]+' | head -1)
```
If branch name doesn't contain an issue ID, try extracting from PR title or body:
```bash
ISSUE_ID=$(gh pr view ${PR_NUMBER} --json title -q '.title' | grep -oE '(GEO|FLY)-[0-9]+' | head -1)
```

### 0d. Branch Verification
Verify the local checkout is on the correct branch before proceeding:
```bash
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [ "$CURRENT_BRANCH" != "$HEAD_BRANCH" ]; then
  git checkout "$HEAD_BRANCH"
fi
```
**This is critical.** Phase 2 mutates git state (git mv, commit, push). Running on the wrong branch would archive docs onto an unrelated branch while leaving the PR unchanged.

## Phase 1: CI Green Gate

### 1a. Wait for CI
```bash
gh pr checks ${PR_NUMBER} --watch
```
Exit code: 0 = all pass, non-zero = has failures.

### 1b. If Failed — Get Failure Details
```bash
gh pr checks ${PR_NUMBER} --json name,bucket,link,workflow,state
```

Get the failed run ID, binding to the current HEAD SHA for stability across reruns:
```bash
HEAD_SHA=$(gh pr view ${PR_NUMBER} --json commits -q '.commits[-1].oid')
RUN_ID=$(gh run list --branch ${HEAD_BRANCH} --workflow CI --commit ${HEAD_SHA} --status failure --limit 1 --json databaseId -q '.[0].databaseId')
```

### 1c. Read Failed Logs
```bash
gh run view ${RUN_ID} --log-failed
```

### 1d. Classify and Fix

| Signal | Classification | Auto-fix |
|--------|---------------|----------|
| biome/lint error | lint | `pnpm format && git add -A && git commit -m "fix: auto-format" && git push` |
| TypeScript compile error | build | Read error → fix code → `git add -A && git commit -m "fix: build error" && git push` |
| Type error | typecheck | Read error → fix types → `git add -A && git commit -m "fix: type error" && git push` |
| Test assertion failure | test | Read assertion → fix code → `git add -A && git commit -m "fix: test failure" && git push` |
| Timeout / network / 5xx | flaky | `gh run rerun ${RUN_ID} --failed` |
| Missing secret / permission | config | Output error details → **exit** (cannot auto-fix) |

### 1e. Re-check After Fix
```bash
gh pr checks ${PR_NUMBER} --watch
```

### 1f. Loop Limit
Repeat 1a-1e up to **3 times**. After 3 attempts:
```
Output: "CI failed after 3 fix attempts. Last failure: {step}: {error summary}"
```
**Exit.** Let the caller decide next steps.

## Phase 2: Pre-merge Archive + Merge

### 2a. Archive Pipeline Docs (if they exist)

**Guard**: If `ISSUE_ID` is empty, skip archiving entirely. An empty pattern would match all files and cause mass-archiving.

```bash
if [ -z "$ISSUE_ID" ]; then
  echo "No ISSUE_ID found — skipping doc archive"
else
  for dir_pair in "doc/plan/inprogress:doc/plan/archive" "doc/research/new:doc/research/archive" "doc/exploration/new:doc/exploration/archive"; do
    src="${dir_pair%%:*}"
    dst="${dir_pair##*:}"
    for f in $(find "$src" -name "*${ISSUE_ID}-*" -type f 2>/dev/null); do
      git mv "$f" "$dst/"
    done
  done
fi
```

If any files were archived, commit and push, then re-enter CI gate:
```bash
if ! git diff --cached --quiet; then
  git commit -m "docs: archive ${ISSUE_ID} docs before merge"
  git push
  # CI will re-run on the new commit — wait for green before merge
  gh pr checks ${PR_NUMBER} --watch
  # If this exits non-zero, the archive commit broke CI.
  # Re-enter Phase 1 (classify + fix). This counts toward the 3-attempt limit.
fi
```
**If `gh pr checks` exits non-zero after the archive commit**, go back to Phase 1b (get failure details) and treat this as a new fix attempt within the loop limit. Do NOT fall through to merge with red CI.

### 2b. Merge (only when CI is green)
```bash
gh pr merge ${PR_NUMBER} --squash --delete-branch
```

### 2c. Confirm Merge
```bash
gh pr view ${PR_NUMBER} --json state,mergedAt
```
Output: "PR #${PR_NUMBER} merged at {mergedAt}. Branch deleted."

## Scope

This skill handles **CI gate + archive + merge only**. It does NOT handle:
- Post-merge bookkeeping (CLAUDE.md, MEMORY.md, VERSION bump, Linear status)
- Escalation routing (SendMessage to team-lead)
- Deployment (Flywheel has no deploy)
- Worktree cleanup

These are the **caller's responsibility**:
- **Orchestrator workers**: handle post-merge inline per orchestrator.md Section 7
- **Manual `/spin`**: follow the Archive stage instructions
- **Direct use**: user handles post-merge bookkeeping themselves

## Important Notes

- **Never merge with red CI.** Always wait for green.
- **If stuck in a loop** (same failure 3+ times), stop and let the caller decide.
- **Flaky tests**: If a test fails due to external APIs or timeouts, `gh run rerun --failed` is correct — don't modify the test.
- **Lint auto-fix**: Always use `pnpm format` (not `pnpm lint --write`).
- **This skill never pushes to main.** All operations happen on the PR feature branch.
