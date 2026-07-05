# Plan Source Contract

Defines how QA agents obtain plan files across worktree boundaries.
Solves the cross-worktree plan access problem (GEO-310).

## Terminology

- **PLAN_RELPATH**: plan file path relative to repo root (repo-relative pathspec)
  Example: `doc/backend/plan/inprogress/v3.32.1-GEO-308-dynamic-qa-v2.md`
- **MAIN_AGENT_BRANCH**: main agent's feature branch name
  Example: `feat/GEO-308-dynamic-qa-v2`
- **WORKTREE_PATH**: QA agent's worktree absolute path

## Rules

1. QA agent's worktree **must** contain the plan file after Step 1 (Onboard)
2. Spawn parameters (orchestrator → QA agent) **must** include:
   - `PLAN_RELPATH` (repo-relative, never absolute)
   - `MAIN_AGENT_BRANCH`
3. Plan acquisition strategy is controlled by `qa-config.yaml` `plan.source`:
   - `worktree` (default): plan is already in current worktree
   - `branch_fetch`: QA agent executes in Step 1:
     ```bash
     git fetch origin ${MAIN_AGENT_BRANCH}
     git checkout origin/${MAIN_AGENT_BRANCH} -- ${PLAN_RELPATH}
     ```
     **Precondition**: MAIN_AGENT_BRANCH must contain the plan commit
4. Absolute path reads are **prohibited** — no cross-worktree filesystem access
5. Plan file in QA worktree is a **read-only copy** — QA does not modify plans
6. If fetch fails, QA agent exits with error (fail-fast), no fallback to absolute paths

## Path Normalization

If legacy spawn parameters pass an absolute path, Step 1 normalizes to repo-relative
using a cross-platform Node.js helper (macOS lacks `realpath --relative-to`):

```bash
PLAN_RELPATH=$(node -e "
  const path = require('path');
  const { execFileSync } = require('child_process');
  const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel']).toString().trim();
  console.log(path.relative(repoRoot, process.argv[1]));
" "$PLAN_PATH")
```

## Spawn Parameter Names

Aligned with existing GeoForge3D conventions:
- `WORKTREE_PATH` — QA agent's worktree absolute path (existing)
- `PLAN_RELPATH` — plan file repo-relative path (new)
- `MAIN_AGENT_BRANCH` — main agent feature branch name (new)
