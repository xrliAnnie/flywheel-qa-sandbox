# Spin — Full Pipeline Orchestrator

Drive a Linear issue through the complete development pipeline: Brainstorm → Research → Plan → Implement → Archive.

**Usage**: `/spin GEO-145` or `/spin` (will ask for issue ID)

## Step 0: Parse & Onboard

### 0a. Get the issue
If an argument is provided (e.g., `GEO-145`), use it as the issue identifier. Otherwise, ask the user.

### 0b. Read the Linear issue
Use the Linear MCP tool `get_issue` to fetch the issue details (title, description, priority, labels, status).

### 0c. Read project context
Read `CLAUDE.md` for naming conventions and pipeline rules. Read `doc/VERSION` for the current version number.

### 0d. Derive slug
From the issue title, derive a kebab-case slug (e.g., "Memory Production Setup" → `memory-production-setup`). This slug is used in all filenames for this issue.

### 0e. Create or enter worktree

**All pipeline work (brainstorm, research, plan, implement) happens in a dedicated worktree — never on main.**

1. Check if a worktree for this issue already exists:
   ```bash
   git worktree list | grep -i "GEO-{XX}\|{slug}"
   ```

2. If **no existing worktree**: create one from latest main:
   ```bash
   git checkout main && git pull origin main
   git worktree add ../flywheel-geo-{XX} -b feat/GEO-{XX}-{slug}
   ```

3. If **worktree already exists**: enter it (it already has the feature branch).

4. **Switch working directory** to the worktree for all subsequent steps:
   ```bash
   cd ../flywheel-geo-{XX}
   ```

All doc writes (exploration, research, plan) and code changes happen in this worktree. When the PR is created, it includes both docs and code — everything enters main through the PR.

## Step 1: Detect Pipeline Stage

Search the doc/ directory to figure out where this issue is in the pipeline. Check in this order — the first match determines the current stage:

| Check | If found | Stage |
|-------|----------|-------|
| `doc/plan/inprogress/*GEO-{XX}*` | Implementation in progress | Resume `/implement` |
| `doc/plan/new/*GEO-{XX}*` | Plan approved, ready to implement | Start `/implement` |
| `doc/plan/draft/*GEO-{XX}*` | Plan drafted, needs review | Run `/codex-design-review` |
| `doc/research/new/*GEO-{XX}*` | Research done, needs plan | Start `/write-plan` |
| `doc/exploration/new/*GEO-{XX}*` | Exploration done, needs research | Start `/research` |
| Nothing found | Fresh issue | Start `/brainstorm` |

Also check `backlog/` and `archive/` directories — if the issue's docs are archived, warn the user that this issue appears to be already completed.

Present the detection result to the user:

```
🔄 GEO-{XX}: {issue title}
   Current stage: {detected stage}
   Next step: {what will happen}

   Proceed?
```

Wait for confirmation before continuing.

## Step 2: Execute Pipeline

Run each remaining stage in sequence. Between each stage, pause and confirm with the user before proceeding to the next.

### Stage: Brainstorm

**Invoke**: `/brainstorm` with the Linear issue context as input.

**Output file**: `doc/exploration/new/GEO-{XX}-{slug}.md`

**Frontmatter** (ensure the generated doc includes):
```markdown
# Exploration: {Title} — GEO-{XX}

**Issue**: GEO-{XX} ({issue title})
**Date**: {today YYYY-MM-DD}
**Status**: Draft
```

After completion, ask: "Exploration complete. Proceed to Research?"

### Stage: Research

**Invoke**: `/research` with the exploration doc path as input argument.

**Output file**: `doc/research/new/GEO-{XX}-{slug}.md`

**Frontmatter**:
```markdown
# Research: {Title} — GEO-{XX}

**Issue**: GEO-{XX}
**Date**: {today YYYY-MM-DD}
**Source**: `doc/exploration/new/GEO-{XX}-{slug}.md`
```

After completion, ask: "Research complete. Proceed to Plan?"

### Stage: Plan

**Invoke**: `/write-plan` with the research doc path as input argument.

**Output file**: `doc/plan/draft/v{VERSION}-GEO-{XX}-{slug}.md`

The version comes from `doc/VERSION`. The plan starts in `draft/`.

**Frontmatter**:
```markdown
# Plan: {Title}

**Version**: v{VERSION}
**Issue**: GEO-{XX}
**Date**: {today YYYY-MM-DD}
**Source**: `doc/exploration/new/GEO-{XX}-{slug}.md`, `doc/research/new/GEO-{XX}-{slug}.md`
**Status**: draft
```

### Stage: Design Review

**Invoke**: `/codex-design-review {plan-file-path}`

This runs Codex to review the plan. It auto-loops until approved (or asks user after 3 rounds).

On approval:
1. Update plan frontmatter: `**Status**: codex-approved`
2. Move: `git mv doc/plan/draft/{file} doc/plan/new/{file}`
3. Say: "Plan approved by Codex. Proceed to Implementation?"

### Stage: Implement

**Invoke**: `/implement {plan-file-path}`

Before starting:
1. Move plan: `git mv doc/plan/new/{file} doc/plan/inprogress/{file}`
2. Update Linear issue status to "In Progress"

**Note**: The worktree and feature branch were already created in Step 0e. `/implement` should detect the existing branch and skip branch creation. Pass `--skip-branch` or rely on `/implement`'s auto-detection of the current feature branch.

### Stage: Archive (after PR merges)

After implementation is shipped (PR merged to main):

1. **Switch to main repo** (not worktree) and pull:
   ```bash
   cd ~/Dev/flywheel  # or the main repo directory
   git pull origin main
   ```

2. **Clean up worktree**:
   ```bash
   git worktree remove ../flywheel-geo-{XX}
   ```

3. Archive docs using **`git mv`** (NOT copy):
   ```bash
   git mv doc/plan/inprogress/{file} doc/plan/archive/{file}
   git mv doc/research/new/GEO-{XX}-*.md doc/research/archive/
   git mv doc/exploration/new/GEO-{XX}-*.md doc/exploration/archive/
   ```
   Only archive docs that exist — not every issue has all three.
   **IMPORTANT**: Always use `git mv`, never `cp`. Copying creates duplicates.

4. Update CLAUDE.md: remove from Active Explorations list

5. Update MEMORY.md: move docs from Active to Archived index

4. Update Linear issue status to "Done"

5. Commit: `docs: archive GEO-{XX} docs after implementation merged`

## Important Rules

- **Never skip stages**. If exploration exists but research doesn't, you must do research before planning. The pipeline is sequential.
- **Never skip design review**. Every plan must pass `/codex-design-review` before implementation.
- **Always confirm** with the user between stages. Don't auto-advance.
- **Follow naming conventions** from CLAUDE.md exactly. Issue ID must be in every filename.
- **Structured frontmatter** is mandatory on every generated document.
- **Update Linear** at key transitions (start → In Progress, done → Done).
- If a stage's skill (`/brainstorm`, `/research`, etc.) doesn't exist or fails, fall back to doing the work directly following the same quality standards.
