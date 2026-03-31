# Orchestrator — Multi-Agent Development Manager

Manages parallel agent execution for Flywheel development using **Agent Teams**. Creates a team with coordinated teammates that run `/spin GEO-XX` in dedicated worktrees.

## CRITICAL: Use Agent Teams, NOT Independent Background Agents

**ALWAYS** use `TeamCreate` → `TaskCreate` → `Agent(team_name=...)` workflow.
**NEVER** spawn independent `Agent(run_in_background=true)` without a team.

## Startup

1. Initialize state DB (use bash explicitly for BASH_SOURCE compatibility):
   ```bash
   bash -c 'source .claude/orchestrator/state.sh && init_db'
   ```

2. **Linear MCP probe**: Try calling the Linear list_issues tool to verify it's available. The MCP namespace varies by environment. If the tool is not available, report error and stop. Cache the working tool handle for this session.

3. **Restart recovery**: Query agents in `running` or `spawned` state. Mark ALL as `failed` with error "lead session restarted, agent unrecoverable". Run `cleanup-agent.sh` for each. Report which agents were terminated and their issue_ids.

4. Report current state: `list_active_agents` + `get_agent_history`

5. **Compute sprint version** (read-only, does NOT write VERSION file):
   ```bash
   bash -c 'source .claude/orchestrator/config.sh && compute_next_version'
   ```
   Store this as `SPRINT_VERSION` (e.g., `v1.18.0`). All branches and plans in this sprint use this version.

6. **Create Team**:
   ```
   TeamCreate(team_name="flywheel-sprint", description="Flywheel parallel development sprint")
   ```

## Reconcile Loop

Repeat every `RECONCILE_INTERVAL` (5 min):

### 1. Discover Issues
- **CRITICAL: Only Flywheel project issues.** Always filter by `project="Flywheel"`. Never pick up GeoForge3D product issues — those are Peter/Oliver/Simba's responsibility.
- Query 1: `project="Flywheel", team="GEO"` (historical Flywheel issues under GEO team)
- Query 2: `project="Flywheel", team="FLY"` (new Flywheel issues under FLY team)
- Exclude: status = Done / Cancelled
- Exclude: issue_id already in agents table (non-terminal)
- When user asks to "find issues to run", always apply `project="Flywheel"` filter. Do NOT recommend GeoForge3D product issues.

### 2. Check Capacity
- Count non-terminal agents in SQLite
- If >= `MAX_CONCURRENT_AGENTS` (5): skip spawning, report "at capacity"

### 3. Claim & Spawn (Team-Based)

For each new issue (up to available slots):

1. `create_agent(id, "executor", version, slug, issue_id)`
   - If UNIQUE violation on issue_id: skip (already claimed by another reconcile)

2. **Create Task** in the team task list:
   ```
   TaskCreate(
     subject="Spin GEO-{XX}: {issue_title}",
     description="Run full /spin pipeline for GEO-{XX} in worktree /Users/xiaorongli/Dev/flywheel-geo-{XX}",
     activeForm="Running GEO-{XX}"
   )
   ```

3. Compute absolute worktree path: `$(cd "$PROJECT_ROOT/.." && pwd)/flywheel-geo-{XX}`

4. `git worktree add <absolute_path> -b feat/{SPRINT_VERSION}-GEO-{XX}-{slug}`
   - Use `SPRINT_VERSION` computed at startup (e.g., `feat/v1.18.0-GEO-200-forum-thread-link`)
   - If fails: `set_agent_error` + `update_agent_status failed` + `cleanup-agent.sh` → skip

5. `set_agent_field(id, "worktree_path", "<absolute_path>")`
6. `set_agent_field(id, "branch", "feat/{SPRINT_VERSION}-GEO-{XX}-{slug}")`
7. `update_agent_status(id, "running")`

8. **Spawn Teammate** (NOT independent background agent):

   **CRITICAL: Give clear, specific guidance.** The prompt MUST include:
   - Exact reference files/code to look at (e.g., "参考 GeoForge3D 的 `.github/workflows/backend-deploy-on-comment.yml`")
   - What approach to take (e.g., "这是 GitHub Actions workflow，不是 CLI skill")
   - What NOT to do (common wrong directions for this type of issue)
   - If the issue has prior art in other repos, point to it explicitly

   Vague prompts lead to agents going in the wrong direction (happened with GEO-292 and FLY-2 in this sprint).

   ```
   Agent(
     description="Spin GEO-{XX} {slug}",
     prompt="You are working in the Flywheel project worktree at {worktree_path} on branch {branch}. Run the full /spin pipeline for GEO-{XX}: {title}. Follow brainstorm → research → write-plan → /codex-design-review-rescue → implement → PR → /codex-code-review-rescue. MANDATORY: After creating the PR, you MUST run /codex-code-review-rescue (or /codex-code-review if rescue unavailable). Do NOT skip code review. Do NOT report PR as done until code review passes. Work ONLY in the worktree. Push to {branch} and create PR against main.",
     name="worker-geo-{XX}",
     team_name="flywheel-sprint",
     run_in_background=true,
     mode="auto"
   )
   ```

9. **Assign Task** to the spawned teammate:
   ```
   TaskUpdate(taskId="{task_id}", owner="worker-geo-{XX}", status="in_progress")
   ```

### 4. Health Check
- Use `TaskList` to check task statuses
- Agents in `spawned` state for >30 min → `failed` + cleanup (spawn likely failed)
- Agents in `running` state for >4h → warn only (might be in User Approval gate)

### 5. Handle PR Creation (DO NOT SHUTDOWN)
When a teammate reports PR created:
- Update task status but **DO NOT shutdown the teammate**
- Report PR URL to user
- Teammate enters **"awaiting ship"** state — idle but alive
- **CRITICAL**: Never send shutdown_request after PR creation. Teammates must stay alive for ship + cleanup.

### 6. Ship Gate (User Approval Required)
After all PRs are created (or user decides to ship a subset):
- Present PR summary table to user
- **Wait for user to confirm** which PRs to ship (e.g., "ship all", "ship #67 #68", "skip #70")
- Only proceed with shipping after explicit user confirmation

### 7. Ship + Cleanup (Teammate Executes)
For each PR the user approves to ship:
1. `SendMessage(to="worker-geo-{XX}", message="Ship PR #{N}: merge, clean up, update docs")`
2. Teammate executes **ALL** of the following (do not skip any):

   **A. Ship via :cool: flow (MANDATORY — do not skip)**

   Push triggers GitHub Actions CI. Wait for CI to pass before merging.

   ```bash
   # 1. Ensure latest code is pushed
   git push origin {branch}

   # 2. Wait for CI checks to complete
   gh pr checks {PR_NUMBER} --watch
   ```

   - **CI green** → proceed to merge
   - **CI red** → fix the failing step:
     1. Read CI failure details: `gh pr checks {PR_NUMBER}`
     2. Fix the issue in the worktree
     3. Commit + push → CI re-triggers automatically
     4. `gh pr checks {PR_NUMBER} --watch` again
     5. Repeat until green
     6. If stuck after 3 fix attempts, escalate to team lead:
        ```
        SendMessage(to="team-lead", message="Ship blocked on PR #{N}: CI failed after 3 fix attempts. Details: {failure}")
        ```

   **Never merge with red CI.**

   **B. Merge PR via :cool: flow (MANDATORY)**
   - Only after CI is green
   - Comment `:cool:` on the PR: `gh pr comment {PR_NUMBER} --body ":cool:"`
   - This triggers the `ship-on-comment.yml` GitHub Actions workflow (CI re-run + squash merge)
   - Wait for merge to complete: `gh pr view {PR_NUMBER} --json state --jq '.state'` until `MERGED`
   - **Do NOT use `gh pr merge` directly** — all ships must go through the `:cool:` flow for audit trail and CI gating

   **B. Clean up worktree**
   - `cd` out of worktree
   - `git worktree remove {worktree_path}`
   - `git branch -D {branch}` (if not already deleted by --delete-branch)

   **C. Archive docs** (in main repo, on main branch)
   - `git mv doc/plan/inprogress/{file} doc/plan/archive/`
   - `git mv doc/exploration/new/{file} doc/exploration/archive/`
   - `git mv doc/research/new/{file} doc/research/archive/` (if exists)
   - Commit: `docs: archive GEO-{XX} docs after merge`

   **D. Update MEMORY.md**
   - Mark issue as ✅ Done in Next Steps table
   - Add one-line summary with PR number, key changes, review rounds

   **E. Update CLAUDE.md + VERSION**
   - Add milestone to the milestone table
   - Bump `doc/VERSION` to `SPRINT_VERSION` if not already bumped (first ship of the sprint writes the new version; subsequent ships in the same sprint skip this step since VERSION is already correct):
     ```bash
     bash -c 'source .claude/orchestrator/config.sh && current=$(get_current_version) && if [ "$current" != "{SPRINT_VERSION}" ]; then bump_feature_version minor; fi'
     ```

   **F. Update Linear issue**
   - Mark issue as Done in Linear

   **G. Report completion**
   - Mark task as completed
   - Report what was done (merge + cleanup + docs)

3. After teammate confirms ALL steps done → `cleanup-agent.sh <id> completed`
4. **THEN** send shutdown_request to that teammate

**CRITICAL**: Steps C-F are mandatory, not optional. Skipping doc updates creates tech debt that accumulates. The teammate has the context to do these updates — don't defer to a follow-up.

### 8. Teammate Communication
- Teammates send messages via `SendMessage` when they need help or finish
- Messages are delivered automatically — no polling needed
- Respond to teammate questions via `SendMessage(to="worker-geo-{XX}", ...)`
- Broadcast to all: `SendMessage(to="*", ...)`

## Agent Lifecycle

```
spawn → /spin pipeline → PR created → WAIT (idle, alive) → user approves → ship + cleanup → shutdown
                                         ↑                         ↑
                                    DO NOT SHUTDOWN          ONLY NOW SHUTDOWN
```

**NEVER shutdown a teammate after PR creation.** The teammate must stay alive to:
1. Execute ship (merge PR)
2. Clean up worktree + local branch
3. Archive docs
4. Only then shutdown

## Interactive Commands

When the user types:
- **"status"** → `TaskList` + `list_active_agents` + `get_agent_history` summary
- **"ship all"** → trigger Ship + Cleanup for all PRs (with user confirmation)
- **"ship #XX"** → trigger Ship + Cleanup for specific PR
- **"stop \<id\>"** → `SendMessage(to="worker-geo-{XX}", message={type:"shutdown_request"})` + `cleanup-agent.sh <id> stopped`
- **"stop all"** → broadcast shutdown to all teammates + cleanup all
- **"dashboard"** → open http://localhost:9474 in browser

## Shutdown

When all ships + cleanups are complete, or user requests stop:
1. `SendMessage(to="*", message={type:"shutdown_request"})` — broadcast shutdown to all remaining teammates
2. Wait for shutdown responses
3. `cleanup-agent.sh` for each agent
4. `TeamDelete` — clean up team and task list

## Restart Recovery

Agent tool background workers **cannot be reattached** after lead session restart. On restart:
- ALL agents in "running" or "spawned" state → mark as **failed** with error "lead session restarted, agent unrecoverable"
- Run cleanup-agent.sh for each (removes worktrees, releases locks)
- Report which agents were terminated and their issue_ids
- `TeamDelete` if stale team exists, then recreate fresh
- Issues will be re-discovered from Linear on next reconcile cycle

This is an explicit design choice: lead restart = all in-flight work is lost.
