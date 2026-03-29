# Orchestrator — Multi-Agent Development Manager

Manages parallel agent execution for Flywheel development. Spawns worker agents that run `/spin GEO-XX` in dedicated worktrees.

## Startup

1. Initialize state DB (use bash explicitly for BASH_SOURCE compatibility):
   ```bash
   bash -c 'source .claude/orchestrator/state.sh && init_db'
   ```

2. **Linear MCP probe**: Try calling the Linear list_issues tool to verify it's available. The MCP namespace varies by environment. If the tool is not available, report error and stop. Cache the working tool handle for this session.

3. **Restart recovery**: Query agents in `running` or `spawned` state. Mark ALL as `failed` with error "lead session restarted, agent unrecoverable". Run `cleanup-agent.sh` for each. Report which agents were terminated and their issue_ids.

4. Report current state: `list_active_agents` + `get_agent_history`

5. Start dashboard in background:
   ```bash
   python3 .claude/orchestrator/dashboard.py &
   ```

## Reconcile Loop

Repeat every `RECONCILE_INTERVAL` (5 min):

### 1. Discover Issues
- Call Linear list_issues (using the handle resolved at startup) with project="Flywheel", team="GEO"
- Exclude: status = Done / Cancelled
- Exclude: issue_id already in agents table (non-terminal)

### 2. Check Capacity
- Count non-terminal agents in SQLite
- If >= `MAX_CONCURRENT_AGENTS` (5): skip spawning, report "at capacity"

### 3. Claim & Spawn

For each new issue (up to available slots):

1. `create_agent(id, "executor", version, slug, issue_id)`
   - If UNIQUE violation on issue_id: skip (already claimed by another reconcile)
2. Compute absolute worktree path: `$(cd "$PROJECT_ROOT/.." && pwd)/flywheel-geo-{XX}`
3. `git worktree add <absolute_path> -b feat/GEO-{XX}-{slug}`
   - If fails: `set_agent_error` + `update_agent_status failed` + `cleanup-agent.sh` → skip
4. `set_agent_field(id, "worktree_path", "<absolute_path>")`
5. `set_agent_field(id, "branch", "feat/GEO-{XX}-{slug}")`
6. `update_agent_status(id, "running")`
7. Spawn worker: `Agent tool (run_in_background=true)` with prompt `/spin GEO-{XX}`
   - If Agent tool spawn fails: `set_agent_error` + `cleanup-agent.sh <id> failed`

### 4. Health Check
- Agents in `spawned` state for >30 min → `failed` + cleanup (spawn likely failed)
- Agents in `running` state for >4h → warn only (might be in User Approval gate)

### 5. Handle Completions
When a background Agent returns:
- Success → `cleanup-agent.sh <id> completed`
- Failure → `set_agent_error` + `cleanup-agent.sh <id> failed`

## Interactive Commands

When the user types:
- **"status"** → `list_active_agents` + `get_agent_history` summary
- **"stop \<id\>"** → `cleanup-agent.sh <id> stopped` (cleanup sets the terminal status directly)
- **"stop all"** → stop all non-terminal agents
- **"dashboard"** → open http://localhost:9474 in browser

## Restart Recovery

Agent tool background workers **cannot be reattached** after lead session restart. On restart:
- ALL agents in "running" or "spawned" state → mark as **failed** with error "lead session restarted, agent unrecoverable"
- Run cleanup-agent.sh for each (removes worktrees, releases locks)
- Report which agents were terminated and their issue_ids
- Issues will be re-discovered from Linear on next reconcile cycle

This is an explicit design choice: lead restart = all in-flight work is lost. The alternative (persisting reattachable handles) adds significant complexity for a rare scenario.
