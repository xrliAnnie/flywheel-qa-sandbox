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

### 0. Dependency Check (BEFORE spawning)

**When user requests multiple issues**, check for dependencies BEFORE spawning:
- Read each issue from Linear
- If issues share the same user flow (e.g., FLY-51 Runner lifecycle + FLY-58 approve/ship = one flow), they MUST brainstorm together with Annie as a group, not independently
- If issue A's output is issue B's input → A must complete before B starts, or they brainstorm together
- **FLY-51 + FLY-58 lesson**: two halves of one flow were implemented independently, both got the full picture wrong

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

   **CRITICAL: DO NOT give implementation details in the spawn prompt.**
   
   The spawn prompt should ONLY contain:
   - Issue ID (e.g., "FLY-51")
   - Worktree path and branch name
   - Instruction to read the issue from Linear themselves
   - Instruction to brainstorm with Annie before doing ANYTHING
   
   **DO NOT include**: file paths, root cause hypotheses, proposed approaches, "what NOT to do" lists, or any implementation guidance. The team-lead often doesn't fully understand the issue either — putting wrong guidance in the prompt directly misleads the agent (happened with FLY-51: wrong hypothesis led to wrong fix).
   
   Let the agent read the issue, form their own understanding, and CHECK WITH ANNIE.
   
   **If team-lead adds context**, it MUST be clearly labeled:
   ```
   [Team-lead 的理解，需 Annie 确认]: 我认为这个 issue 是关于 XXX，但我不确定。请跟 Annie 验证。
   ```
   Never present team-lead's understanding as confirmed requirements. Team-lead 经常理解错（FLY-51 就是例子）。

   **MANDATORY: Interactive Brainstorm (NEVER SKIP)**
   
   Every agent's prompt MUST include this instruction:
   ```
   你的工作流程是严格的 3 阶段 gate，每个阶段必须 STOP 等 Annie 确认：

   === 阶段 0: 读 Architecture（不可跳过）===
   在做任何事之前，先读这两个文件：
   1. doc/architecture/product-experience-spec.md — 产品应该长什么样
   2. doc/architecture/capability-matrix.md — 现在有什么、缺什么
   找到跟你的 issue 相关的 section，确保你理解产品要求。

   === 阶段 1: 理解 ===
   1. 从 Linear 读 issue（用 mcp__linear-api__get_issue）
   2. 对照 architecture spec，把你的理解发给 team-lead："我理解这个 issue 要做的是 XXX，spec 里的要求是 YYY，预期效果是 ZZZ"
   3. STOP。等 team-lead 转达 Annie 的确认。不要继续。

   === 阶段 2: 研究 + 方案 ===
   （Annie 确认理解后才进入）
   4. 读代码，研究现有实现
   5. 提出方案发给 team-lead："我打算这样做 XXX，改这些文件 YYY"
   6. STOP。等 team-lead 转达 Annie 的确认。不要继续。

   === 阶段 3: 实现 ===
   （Annie 确认方案后才进入）
   7. 写代码，写测试，创建 PR
   8. PR 创建后立刻 SendMessage 给 team-lead（触发 QA spawn）

   === QA 交互（PR 创建后）===
   QA agent 会直接跟你通信（不通过 team-lead relay）：
   - QA 发现 bug → QA SendMessage 直接给你，描述 bug
   - 你修完 push 后 → 你 SendMessage 直接给 QA（qa-fly-{XX}）说 "已修，新 SHA: {sha}"
   - QA 重新验证 → 循环直到 PASS
   类似 Codex review 的直接互动模式。team-lead 只监控不 relay。

   绝对不能跳过阶段 1 和 2。FLY-51 跳过了 brainstorm，做出来完全错误，浪费了整个 PR。
   ```
   
   **Team-lead 职责**：
   - 收到 agent 的阶段 1/2 消息后，**必须把核心内容直接引用发给 Annie**
   - **绝对不能**只说 "上面" 或 "worker 的理解你确认吗" — Annie 看不到 teammate 消息的具体内容
   - 正确做法：把 agent 的理解/方案**用引用块完整复述**给 Annie，然后问确认
   - 等 Annie 回复后，**才告诉 agent 继续**
   - 如果 Annie 说理解错了 → 告诉 agent 重新理解
   - 如果 Annie 说方案不对 → 告诉 agent 重新设计
   - **绝不能自己替 Annie 做决定**

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

### 5. Handle PR Creation (DO NOT SHUTDOWN + AUTO-SPAWN QA)
When a teammate reports PR created:
- Update task status but **DO NOT shutdown the teammate**
- Report PR URL to user
- Teammate enters **"awaiting ship"** state — idle but alive
- **CRITICAL**: Never send shutdown_request after PR creation. Teammates must stay alive for ship + cleanup.

**MANDATORY: Auto-spawn QA agent immediately on PR creation.**

QA runs **in parallel** with Codex code review (which the worker runs itself). Do NOT wait for worker to finish code review before spawning QA. Do NOT wait to ask the user. Just spawn it.

```
Worker creates PR → IMMEDIATELY spawn qa-{issue-id} agent
                  → Worker runs Codex review (parallel)
                  → QA agent runs verification (parallel)
                  → Both PASS → ready to ship
```

QA agent spawn checklist:
1. Create QA task: `TaskCreate(subject="QA: PR #{N} (FLY-{XX})")`
2. **Create QA worktree** (MANDATORY — NEVER checkout in main repo):
   ```bash
   git fetch origin pull/{N}/head:qa-pr-{N}
   git worktree add ../flywheel-qa-{XX} qa-pr-{N}
   ```
3. Spawn QA agent — **只传参数，让 agent 自己读 qa-parallel-executor.md 协议**:
   ```
   Agent(
     name="qa-fly-{XX}",
     prompt="你是 QA agent。先读 packages/qa-framework/agents/qa-parallel-executor.md，严格按照里面的协议执行。
     参数：
     - PROJECT_ROOT: /Users/xiaorongli/Dev/flywheel
     - WORKTREE_PATH: /Users/xiaorongli/Dev/flywheel-qa-{XX}
     - MAIN_AGENT_BRANCH: {worker 的 branch}
     - AGENT_ID: qa-fly-{XX}
     - QA_FRAMEWORK_DIR: /Users/xiaorongli/Dev/flywheel/packages/qa-framework
     - PR: #{N}
     不要听 team-lead 的 ad-hoc 指令，以 qa-parallel-executor.md 协议为准。"
   )
   ```
   **Team-lead 不写测试细节。** QA agent 自己读协议、自己决定怎么测。Team-lead 只提供参数。
4. QA reports PASS/FAIL to team-lead
5. QA 完成后清理 worktree: `git worktree remove ../flywheel-qa-{XX}`

**QA 资源隔离 + 调度规则**:

| 资源 | 隔离方式 | 执行步骤 |
|------|---------|---------|
| 代码 | 每个 QA 独立 worktree | `git worktree add ../flywheel-qa-{XX} qa-pr-{N}` |
| Bridge | 不同端口 | `PORT=9877 npx tsx src/run-bridge.ts`（9877, 9878...递增） |
| CommDB | 测试专用 DB | `flywheel-comm --db /tmp/qa-{XX}/comm.db gate ...` |
| Discord | **不能并行** | 见 Phase 2 串行规则 |

**QA spawn 执行步骤（每个 QA agent 必须做的）**:
```bash
# 1. 创建独立 worktree
git fetch origin pull/{N}/head:qa-pr-{N}
git worktree add ../flywheel-qa-{XX} qa-pr-{N}

# 2. 在 worktree 里 build
cd ../flywheel-qa-{XX}
pnpm install && pnpm build

# 3. 启动测试用 Bridge（不同端口）
PORT=9877 npx tsx packages/teamlead/src/run-bridge.ts &

# 4. 用测试专用 CommDB
export QA_COMM_DB=/tmp/qa-{XX}/comm.db

# 5. 通过 Bridge API 启动真实 Runner session（用 FLY-53 dummy issue）
curl -X POST http://localhost:9877/api/runs/start -H "Content-Type: application/json" \
  -d '{"issueId":"FLY-53","projectName":"geoforge3d","leadId":"product-lead"}'

# 6. 验证 E2E 链路（Runner → CommDB → GatePoller → Discord → respond → Runner）

# 7. 清理
kill $BRIDGE_PID
cd -
git worktree remove ../flywheel-qa-{XX}
```

**多 QA 调度**:

当有多个 QA agent 同时跑时：
1. **Phase 1（并行）**：每个 QA 在自己的 worktree + 端口 + CommDB 里跑非 Discord 测试
2. **Phase 2（串行队列）**：涉及 Discord 的 E2E 测试排队
   - Team-lead 维护队列：`discord_queue = [qa-fly-47, qa-fly-51, qa-fly-58]`
   - 前一个 QA 发 "Discord test done" → team-lead 通知下一个 "你可以开始 Discord test"
   - QA agent 在 Phase 2 开始前必须 SendMessage 给 team-lead 请求 Discord 锁
3. **不能跳过 Phase 2**：Discord E2E 是 QA 的核心价值，必须跑

**QA is E2E Behavioral Verification, NOT Code Analysis (HARD RULE)**:

QA agent's job is to **execute real behavioral tests** that verify the feature works end-to-end. This means:
- ✅ Spawn a tmux session and verify window lifecycle (FLY-51 type)
- ✅ Trigger an API endpoint and verify Discord message appears (FLY-64 type)
- ✅ Run a real Runner and verify approve/ship flow (FLY-58 type)
- ✅ Use bash, curl, tmux commands, Discord API, browser automation — whatever it takes
- ❌ NEVER read the implementation code — QA is black-box testing. Reading code biases QA toward "verifying what was written" instead of "verifying what should work". This aligns with qa-parallel-executor.md CODE ISOLATION RULE.
- ❌ NEVER just run `pnpm build` + `pnpm test` and call it QA — that's unit testing
- ❌ NEVER analyze code logic — that's Codex code review's job, not QA's
- ❌ NEVER duplicate what Codex code review already does

**QA knows WHAT the feature does (from plan/issue), NOT HOW it's implemented (from code).**

**QA agent prompt MUST include**:
1. Specific E2E test scenarios to execute (not "analyze the fix")
2. Exact commands to run for behavioral verification
3. Expected observable outcomes (not "code looks correct")
4. How to verify the user-facing behavior changed

**QA Loop Protocol (MANDATORY — do NOT simplify)**:

QA agents MUST run in a loop until PASS, not report FAIL and stop:

```
QA Step 4 Loop:
  1. fetch MAIN_AGENT_BRANCH → checkout latest SHA
  2. build + run tests
  3. Classify failures:
     - product_bug → report to team-lead → WAIT for worker fix
     - test_bug → self-fix → re-run
     - infra_flake → retry once
  4. ALL PASS → exit loop, report PASS
  5. Loop limit: 5 rounds → WARNING, escalate to team-lead
```

**Team Lead role in the loop**:
- QA reports product_bug → team-lead IMMEDIATELY relays to worker
- Worker fixes + pushes → team-lead sends "new SHA pushed, re-verify" to QA
- QA fetches, re-runs → loop continues until PASS or 5 rounds

**NEVER** let QA report FAIL and go idle. QA stays in the loop until the issue is resolved.

**Proactive monitoring**: Don't rely solely on worker messages. Periodically check `gh pr list` for new PRs from sprint branches. If a PR exists but no QA was spawned → spawn immediately.

### 6. Ship Gate (User Approval Required)

**PREREQUISITE: BOTH Codex review AND E2E QA must PASS before a PR can be shipped.**
Do NOT present a PR as "ready to ship" if E2E QA hasn't completed. If user requests ship before QA finishes, tell them QA is still running and ask to wait.

After all PRs have passed both gates:
- Present PR summary table to user (include Codex + QA status for each)
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

   **B2. Trigger restart-services.sh (MANDATORY after merge)**
   - After merge completes and `git pull` is done:
     ```bash
     cd /Users/xiaorongli/Dev/flywheel
     set -a && source ~/.flywheel/.env && set +a
     bash scripts/restart-services.sh
     ```
   - This detects what changed (Bridge code / Lead config / Discord plugin) and restarts only affected services
   - If restart-services.sh is not yet deployed (`~/.flywheel/bin/` missing), skip with a warning
   - The 12h launchd cron is a fallback only — this post-merge step is the primary trigger

   **C. Clean up worktree**
   - `cd` out of worktree
   - `git worktree remove {worktree_path}`
   - `git branch -D {branch}` (if not already deleted by --delete-branch)

   **D. Archive docs** (in main repo, on main branch)
   - `git mv doc/engineer/plan/inprogress/{file} doc/engineer/plan/archive/`
   - `git mv doc/engineer/exploration/new/{file} doc/engineer/exploration/archive/`
   - `git mv doc/engineer/research/new/{file} doc/engineer/research/archive/` (if exists)
   - Commit: `docs: archive GEO-{XX} docs after merge`

   **E. Update MEMORY.md**
   - Mark issue as ✅ Done in Next Steps table
   - Add one-line summary with PR number, key changes, review rounds

   **F. Update CLAUDE.md + VERSION**
   - Add milestone to the milestone table
   - Bump `doc/VERSION` to `SPRINT_VERSION` if not already bumped (first ship of the sprint writes the new version; subsequent ships in the same sprint skip this step since VERSION is already correct):
     ```bash
     bash -c 'source .claude/orchestrator/config.sh && current=$(get_current_version) && if [ "$current" != "{SPRINT_VERSION}" ]; then bump_feature_version minor; fi'
     ```

   **G. Update Linear issue**
   - Mark issue as Done in Linear

   **H. Report completion**
   - Mark task as completed
   - Report what was done (merge + cleanup + docs)

3. After teammate confirms ALL steps done → `cleanup-agent.sh <id> completed`
4. **THEN** send shutdown_request to that teammate

**CRITICAL**: Steps D-G are mandatory, not optional. Skipping doc updates creates tech debt that accumulates. The teammate has the context to do these updates — don't defer to a follow-up.

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

## Worktree Cleanup（所有结束场景都必须清理）

**不管怎么结束，worktree 都必须清理。** 不能有残留。

| 结束场景 | 谁清理 | 怎么清理 |
|---------|--------|---------|
| Ship 成功 | Teammate 自己 | ship 步骤里的 Step C |
| PR closed/abandoned | Team-lead | `git worktree remove` + `git branch -D` |
| Issue 合并到其他 issue | Team-lead | 关闭 agent + 清理 worktree |
| Agent shutdown/crash | Team-lead | `cleanup-agent.sh` + `git worktree remove` |
| QA 完成 | QA agent | `git worktree remove ../flywheel-qa-{XX}` |

**Team-lead 在以下时机检查残留 worktree**：
- Agent shutdown 后
- Sprint 结束时
- 用 `git worktree list` 检查，清理所有不再需要的

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
