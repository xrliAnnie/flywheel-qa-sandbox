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
| `doc/engineer/plan/inprogress/*GEO-{XX}*` | Implementation in progress | Resume `/implement` |
| `doc/engineer/plan/new/*GEO-{XX}*` | Plan approved, ready to implement | Start `/implement` |
| `doc/engineer/plan/draft/*GEO-{XX}*` | Plan drafted, needs review | Run `/codex-design-review` |
| `doc/engineer/research/new/*GEO-{XX}*` | Research done, needs plan | Start `/write-plan` |
| `doc/engineer/exploration/new/*GEO-{XX}*` | Exploration done, needs research | Start `/research` |
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

**Output file**: `doc/engineer/exploration/new/{ISSUE_ID}-{slug}.md`

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

**Output file**: `doc/engineer/research/new/GEO-{XX}-{slug}.md`

**Frontmatter**:
```markdown
# Research: {Title} — GEO-{XX}

**Issue**: GEO-{XX}
**Date**: {today YYYY-MM-DD}
**Source**: `doc/engineer/exploration/new/GEO-{XX}-{slug}.md`
```

After completion, ask: "Research complete. Proceed to Plan?"

### Stage: Plan

**Invoke**: `/write-plan` with the research doc path as input argument.

**Output file**: `doc/engineer/plan/draft/v{VERSION}-GEO-{XX}-{slug}.md`

The version comes from `doc/VERSION`. The plan starts in `draft/`.

**Frontmatter**:
```markdown
# Plan: {Title}

**Version**: v{VERSION}
**Issue**: GEO-{XX}
**Date**: {today YYYY-MM-DD}
**Source**: `doc/engineer/exploration/new/GEO-{XX}-{slug}.md`, `doc/engineer/research/new/GEO-{XX}-{slug}.md`
**Status**: draft
```

### Stage: Design Review

**Invoke**: `/codex-design-review {plan-file-path}`

This runs Codex to review the plan. It auto-loops until approved (or asks user after 3 rounds).

On approval:
1. Update plan frontmatter: `**Status**: codex-approved`
2. Move: `git mv doc/engineer/plan/draft/{file} doc/engineer/plan/new/{file}`
3. Say: "Plan approved by Codex. Proceed to Implementation?"

### Stage: Implement

**Invoke**: `/implement {plan-file-path}`

Before starting:
1. Move plan: `git mv doc/engineer/plan/new/{file} doc/engineer/plan/inprogress/{file}`
2. Update Linear issue status to "In Progress"

**Note**: The worktree and feature branch were already created in Step 0e. `/implement` should detect the existing branch and skip branch creation. Pass `--skip-branch` or rely on `/implement`'s auto-detection of the current feature branch.

### Stage: Approve (MANDATORY — wait for Annie after PR created)

After `/implement` creates the PR, you MUST wait for Annie's explicit approval before shipping.

**This gate is enforced by flywheel-comm.** The command blocks until Annie responds.

1. **Report stage** to Bridge:
   ```bash
   # If running inside Flywheel Runner (env vars available)
   if [ -n "$FLYWHEEL_COMM_CLI" ] && [ -n "$FLYWHEEL_LEAD_ID" ] && [ -n "$FLYWHEEL_EXEC_ID" ]; then
     node "$FLYWHEEL_COMM_CLI" stage pr_created
   fi
   ```

2. **Run the approve gate** (BLOCKS until Annie approves):
   ```bash
   if [ -n "$FLYWHEEL_COMM_CLI" ] && [ -n "$FLYWHEEL_LEAD_ID" ] && [ -n "$FLYWHEEL_EXEC_ID" ]; then
     node "$FLYWHEEL_COMM_CLI" gate approve_to_ship \
       --lead "$FLYWHEEL_LEAD_ID" \
       --exec-id "$FLYWHEEL_EXEC_ID" \
       --timeout 86400000 \
       --timeout-behavior fail-close \
       --stage approve \
       "PR created: {PR_URL}. Ready for review."
   else
     # Running outside Flywheel (manual /spin) — ask the user directly
     echo "PR created. Please review and approve before shipping."
     # Wait for user confirmation before proceeding
   fi
   ```

3. **Read the response.** If Annie requests changes:
   - Address the changes, push to the PR branch
   - Re-run the gate (step 2) to get fresh approval
   - Do NOT proceed to Ship without explicit approval

**CRITICAL**: Do NOT skip this gate. Do NOT proceed to Ship until the gate command returns successfully. Silence is NOT approval.

### Stage: Ship (after PR created + code review approved)

**Step 1: Archive docs on feature branch** (before merge):
```bash
ISSUE_ID="{ISSUE_ID}"
if [ -n "$ISSUE_ID" ]; then
  for dir_pair in "doc/engineer/plan/inprogress:doc/engineer/plan/archive" "doc/engineer/research/new:doc/engineer/research/archive" "doc/engineer/exploration/new:doc/engineer/exploration/archive"; do
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

**Step 2: Trigger ship and monitor the ship workflow**

**Phase A: Record baseline and trigger**
```bash
# Dual filter: workflow + event (no --branch: issue_comment runs on default branch, not PR branch)
PREV_RUN_ID=$(gh run list -w "ship-on-comment.yml" -e issue_comment --limit 1 --json databaseId -q '.[0].databaseId' 2>/dev/null || echo "0")

# Trigger ship
gh pr comment {PR_NUMBER} --body ":cool:"
```

**Phase B: Locate the NEW ship run (must be newer than baseline)**
```bash
# Poll until a new run appears (databaseId > PREV_RUN_ID)
FOUND_RUN=false
for i in $(seq 1 12); do  # max 60s (12 x 5s)
  sleep 5
  RUN_ID=$(gh run list -w "ship-on-comment.yml" -e issue_comment --limit 1 --json databaseId -q '.[0].databaseId' 2>/dev/null || echo "0")
  if [ "$RUN_ID" != "$PREV_RUN_ID" ] && [ "$RUN_ID" != "0" ]; then
    echo "[ship] Found new run: $RUN_ID"
    FOUND_RUN=true
    break
  fi
  # Also check if PR was already merged (e.g., by a prior queued run)
  STATE=$(gh pr view {PR_NUMBER} --json state -q '.state')
  if [ "$STATE" = "MERGED" ]; then echo "[ship] PR already merged!"; FOUND_RUN=merged; break; fi
done
if [ "$FOUND_RUN" = "merged" ]; then
  echo "[ship] PR already merged — skipping to Phase D."
elif [ "$FOUND_RUN" = "false" ]; then
  echo "[ship] ERROR: no new ship-on-comment.yml run appeared within 60s. Escalating."
  exit 1  # Hard stop — do NOT proceed with stale RUN_ID
fi
```

**Phase C: Watch the run and fix CI failures (max 3 attempts)**
Skip this phase entirely if `FOUND_RUN=merged` (jump to Phase D).
```bash
ATTEMPT=0
MAX_ATTEMPTS=3
while [ $ATTEMPT -lt $MAX_ATTEMPTS ]; do
  ATTEMPT=$((ATTEMPT + 1))

  # Watch the ship workflow run
  gh run watch "$RUN_ID" --exit-status && break  # exits 0 if passed

  # Run failed — diagnose
  echo "[ship] CI failed (attempt $ATTEMPT/$MAX_ATTEMPTS). Diagnosing..."
  gh run view "$RUN_ID" --log-failed

  if [ $ATTEMPT -ge $MAX_ATTEMPTS ]; then
    echo "[ship] FAILED after $MAX_ATTEMPTS attempts. Escalating."
    break
  fi

  # Fix the issue:
  # 1. Read the failure logs above
  # 2. Diagnose root cause (lint/type/test/build)
  # 3. Fix, commit, push
  # 4. Re-trigger with baseline disambiguation
  PREV_RUN_ID="$RUN_ID"
  gh pr comment {PR_NUMBER} --body ":cool:"
  # Wait for new run (same dual filter as Phase B, with fail-close)
  FOUND_RETRY_RUN=false
  for i in $(seq 1 12); do
    sleep 5
    RUN_ID=$(gh run list -w "ship-on-comment.yml" -e issue_comment --limit 1 --json databaseId -q '.[0].databaseId' 2>/dev/null || echo "0")
    if [ "$RUN_ID" != "$PREV_RUN_ID" ] && [ "$RUN_ID" != "0" ]; then FOUND_RETRY_RUN=true; break; fi
  done
  if [ "$FOUND_RETRY_RUN" = "false" ]; then
    echo "[ship] ERROR: no new run appeared after retry within 60s. Escalating."
    break
  fi
done
```

**Phase D: Verify merge**
```bash
STATE=$(gh pr view {PR_NUMBER} --json state -q '.state')
if [ "$STATE" = "MERGED" ]; then echo "[ship] PR merged!"; fi
if [ "$STATE" = "OPEN" ]; then echo "[ship] ERROR: CI passed but PR not merged. Check workflow logs."; fi
```

If all 3 attempts fail, report to Lead/Annie with the last failure details.
**Never proceed to Step 3 with red CI. Never merge manually.**

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
7. **Emit `session_completed` — terminal event for Bridge** (FLY-108):
   ```bash
   # MUST be the LAST sync step. `runPostShipFinalization` (tmux kill +
   # chat-thread archive + sidebar cleanup) fires as soon as Bridge receives
   # this event — so all prior bookkeeping (docs archive, MEMORY/Linear
   # update, restart-services, worktree remove, docs commit+push) must be
   # done. 4 retries with exponential backoff; on all-fail, writes a marker
   # file to `$HOME/.flywheel/state/complete-failed/${FLYWHEEL_EXEC_ID}.json`
   # and exits 1 (fail-close — stale patrol reconciles later).
   if [ -z "$FLYWHEEL_COMM_CLI" ] || [ -z "$FLYWHEEL_EXEC_ID" ]; then
     echo "[complete] FATAL: FLYWHEEL_COMM_CLI or FLYWHEEL_EXEC_ID not set."
     echo "[complete] Runner was not launched with flywheel-comm injected — cannot"
     echo "[complete] emit session_completed. Session will be stuck at 'running' until"
     echo "[complete] stale patrol reconciles. Check TmuxAdapter CLI injection."
     exit 1
   fi
   if ! node "$FLYWHEEL_COMM_CLI" complete \
       --route auto_approve \
       --pr "{PR_NUMBER}" \
       --merged \
       --session-role main ; then
     echo "[complete] ERROR: session_completed emit failed after 4 retries."
     echo "[complete] Marker written to \$HOME/.flywheel/state/complete-failed/."
     echo "[complete] DO NOT manually mark session completed — let stale patrol reconcile."
     exit 1
   fi
   ```

**`needs_review` path (Annie must review; no auto-ship)**: after `/implement`
creates the PR and BEFORE Annie approves, Runner emits:

```bash
if [ -z "$FLYWHEEL_COMM_CLI" ] || [ -z "$FLYWHEEL_EXEC_ID" ]; then
  echo "[complete] FATAL: FLYWHEEL_COMM_CLI or FLYWHEEL_EXEC_ID not set."
  echo "[complete] Cannot emit needs_review session_completed — check TmuxAdapter CLI injection."
  exit 1
fi
if ! node "$FLYWHEEL_COMM_CLI" complete \
    --route needs_review \
    --pr "{PR_NUMBER}" \
    --session-role main ; then
  echo "[complete] ERROR: needs_review session_completed emit failed after 4 retries."
  exit 1
fi
```

This drives `running → awaiting_review` (FSM-legal). `runPostShipFinalization`
does NOT fire (predicate fails: existingStatus ≠ approved_to_ship AND route ≠
auto_approve+merged), so tmux stays open and Runner idles until Annie
approves. After approve + ship, Step 3.7 above emits `auto_approve+merged`
from `approved_to_ship → completed` — which is FSM-legal and triggers
finalization exactly once (atomic claim in `post-ship-finalization.ts`).

## Important Rules

- **Never skip stages**. If exploration exists but research doesn't, you must do research before planning. The pipeline is sequential.
- **Never skip design review**. Every plan must pass `/codex-design-review` before implementation.
- **Always confirm** with the user between stages. Don't auto-advance.
- **Follow naming conventions** from CLAUDE.md exactly. Issue ID must be in every filename.
- **Structured frontmatter** is mandatory on every generated document.
- **Update Linear** at key transitions (start → In Progress, done → Done).
- If a stage's skill (`/brainstorm`, `/research`, etc.) doesn't exist or fails, fall back to doing the work directly following the same quality standards.
- **Never exit `/spin` without a successful `flywheel-comm complete`** (FLY-108). This is the only signal Bridge recognizes as "Runner finished". Skipping it leaves `sessions.status = running`, blocks `close_runner`, and suppresses the `🏁` notification.
