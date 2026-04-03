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

### Stage: Brainstorm (MUST be interactive with Annie — Annie MUST explicitly approve before proceeding)

**CRITICAL**: DO NOT skip this step. DO NOT guess requirements. DO NOT start coding without Annie's EXPLICIT approval.

**Step 1 — Present issue to Annie and ASK as many questions as needed:**

Read the Linear issue, then ask **尽可能多的问题** to truly understand what Annie wants. Don't assume anything.

```
📋 {ISSUE_ID}: {issue title}

Linear 描述: {issue description summary}

在动手之前，我需要问你几个问题：

**产品/体验层面：**
1. 这个功能给谁用的？
2. 用户的完整使用流程是什么？
3. 输出应该长什么样？能给个具体例子吗？
4. 如果出错了，用户应该看到什么？
5. 这个功能需要在哪些地方可见？

**技术/范围层面：**
6. 这个只对某一个 Lead 有效，还是所有 Lead 都需要？
7. 有没有类似的功能已经做过了，我可以参考？
8. 有什么边界情况你担心的？
9. 最简单可用的版本是什么？
10. 有没有 deployment 注意事项？
```

根据 Annie 的回答继续追问，直到完全理解。Annie 宁可你多问也不要你乱做。

**Step 2 — Confirm scope and WAIT for explicit approval:**

```
确认 scope:
✅ 要做: [list]
❌ 不做: [list]
📋 预期行为: [specific examples]

这样对吗？
```

**Annie 没有明确说 "OK" / "approved" / "可以" / "对" 之前，绝对不能进入下一步。**
沉默不是 approve。"嗯" 不是 approve。必须有明确的确认词。

**Step 3 — Write exploration doc:**

Only AFTER Annie explicitly approves, invoke `/brainstorm` with the confirmed requirements.

**Output file**: `doc/exploration/new/{ISSUE_ID}-{slug}.md`

**Frontmatter**:
```markdown
# Exploration: {Title} — {ISSUE_ID}

**Issue**: {ISSUE_ID} ({issue title})
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

### Stage: Ship (after PR created + code review approved)

**Step 1: Archive docs on feature branch** (before merge):
```bash
ISSUE_ID="{ISSUE_ID}"
if [ -n "$ISSUE_ID" ]; then
  for dir_pair in "doc/plan/inprogress:doc/plan/archive" "doc/research/new:doc/research/archive" "doc/exploration/new:doc/exploration/archive"; do
    src="${dir_pair%%:*}"; dst="${dir_pair##*:}"
    for f in $(find "$src" -name "*${ISSUE_ID}-*" -type f 2>/dev/null); do
      git mv "$f" "$dst/"
    done
  done
  if ! git diff --cached --quiet; then
    git commit -m "docs: archive ${ISSUE_ID} docs before merge"
    git push
  fi
fi
```

**Step 2: Trigger ship** — comment `:cool:` on the PR:
```bash
gh pr comment {PR_NUMBER} --body ":cool:"
```
The `ship-on-comment.yml` GitHub Actions workflow runs CI (build + typecheck + lint + test) and squash merges if green. Wait for merge:
```bash
sleep 10  # let Actions register the run
while true; do
  STATE=$(gh pr view {PR_NUMBER} --json state -q '.state')
  if [ "$STATE" = "MERGED" ]; then echo "PR merged"; break; fi
  if [ "$STATE" = "CLOSED" ]; then echo "PR closed without merge"; exit 1; fi
  sleep 30
done
```
If the PR stays OPEN for >15 min, the ship workflow likely failed. Check comments for details, fix the issue, and post `:cool:` again.

**Step 3: Post-merge bookkeeping** (after PR is merged):
```bash
MAIN_REPO=$(git worktree list --porcelain | head -1 | sed 's/^worktree //')
cd "$MAIN_REPO" && git checkout main && git pull origin main
```
1. Update CLAUDE.md: add milestone to table, remove from Active Explorations if listed
2. Update MEMORY.md (local file): move docs from Active to Archived index, mark Done
3. Update Linear issue status to "Done"
4. Restart services (Flywheel repo only):
   ```bash
   MAIN_REPO=$(git worktree list --porcelain | head -1 | sed 's/^worktree //')
   if [[ "$(basename "$MAIN_REPO")" == "flywheel" ]]; then
       bash "$MAIN_REPO/scripts/restart-services.sh" 2>&1 | tee -a /tmp/flywheel-restart.log || echo "[spin] WARNING: restart-services.sh failed (non-blocking)"
   fi
   ```
5. Clean up worktree: `MAIN_REPO=$(git worktree list --porcelain | head -1 | sed 's/^worktree //') && cd "$MAIN_REPO" && git worktree remove ../flywheel-geo-{XX}`
6. Commit + push docs changes: `docs: update docs after {ISSUE_ID} merge`

## Important Rules

- **Never skip stages**. If exploration exists but research doesn't, you must do research before planning. The pipeline is sequential.
- **Never skip design review**. Every plan must pass `/codex-design-review` before implementation.
- **Always confirm** with the user between stages. Don't auto-advance.
- **Follow naming conventions** from CLAUDE.md exactly. Issue ID must be in every filename.
- **Structured frontmatter** is mandatory on every generated document.
- **Update Linear** at key transitions (start → In Progress, done → Done).
- If a stage's skill (`/brainstorm`, `/research`, etc.) doesn't exist or fails, fall back to doing the work directly following the same quality standards.
