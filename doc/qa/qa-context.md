# QA Context — Flywheel

Accumulated QA knowledge across sessions. Read at onboard, write at finalize.

## 2026-07-04: FLY-849 — 793 batch 组合集成 E2E（793+795+799+cmux）

三个 PR（#436 FLY-795 / #426 FLY-799 / #435 cmux）合并到一条分支时只有 `run-dispatcher.ts` 一处真冲突预期（795 的 resume `shareParentBranch` 逻辑 + cmux 的 `runnerDisplayName()` 分处同一 `ctx` 对象字面量不同行），`git merge` 的 3-way diff 自动正确拼合，**零手工 conflict 解决**——大合并前先用 `git diff origin/main...<branch> --name-only` 三两两求交集，能提前算出真实冲突面有多小。

**795 restart-resilient resume 的真机验证配方**：让 Design phase 真跑到写过至少一次 `flywheel-comm progress`（账本已提交到 branch B）之后，`POST /actions/terminate` 模拟 explicit-terminate，再对**同一 issueId** 重新 `POST /api/runs/start`——Blueprint 注入的 prompt 会明确告诉新 runner "这是 resume 场景，读取上一个 runner 的进度账本"，progress 序号从断点接续（不是从 1 开始），同一 worktree/branch 全程复用。这是目前验证 795 最直接的真机手法。

**PhaseOrchestrator config 快照坑**（793 原生行为，非回归）：`plugin.ts` 里 `resolveThreeStage` 的 `pipelineConfigByProject` 只在 **Bridge 启动时** 读一次并闭包捕获；`/api/runs/start` 的新鲜入口判断则是每次活读。给已跑起来的 Bridge 现改 `pipeline.three_stage: true`（不重启）：**新 issue 能正确进 Design**，但**已完成阶段的 handoff 会静默 no-op**（`resolveThreeStage().enabled` 拿到旧快照 `false`，PhaseOrchestrator 认为不是三段式直接跳过，卡在 `design_done` 不报错）。**必须重启 Bridge**（`reconcileOnStartup` 会补跑 stranded `design_done` 的 handoff）。三段式项目 onboard 记得叮嘱这条。

**手动模拟 phase 完成的坑（当真 runner 卡死/无法用时）**：`flywheel-comm complete --route phase_design_complete` / `needs_review` / `auto_approve --merged` 都要求当前 CWD 是那个 phase 的 worktree（用于 evidence collection 的 git diff/log），配套 `FLYWHEEL_EXEC_ID`/`FLYWHEEL_ISSUE_ID`/`FLYWHEEL_PROJECT_NAME`/`FLYWHEEL_BRIDGE_URL` 四个 env（从该 exec 的真实进程 `ps eww` 里能挖出正确值）。`gate approve_to_ship --no-block` 先拿 `questionId`，再 `complete --route needs_review --question-id <id>` 绑定。**⚠️ 手动跑 `gate`/`respond`/`verify-approval` 时必须显式传 `--db`（+ `verify-approval` 还要 `--state-db`）**——不传会 fall back 到 `FLYWHEEL_COMM_DB`/`FLYWHEEL_STATE_DB_PATH` 环境变量,如果这些变量恰好指向生产库(比如你自己就是个 Runner,继承了自己会话的生产 env),会静默写进/读错生产 CommDB 或 StateStore 而不报错。若对一个已 `terminated` 的 session 补发 `complete`，WorkflowFSM 会正确拒绝（`pre-state=terminated → target=awaiting_review not allowed`）——只能对仍处在 pre-terminal 状态的 session 补发。

**529 Room 部署时 TMPDIR 环境坑（新增一例）**：QA runner 自己的 `TMPDIR` 若落在 `~/.flywheel/runner-state/<exec-id>/browser-tmp/` 下（本例 89 字符深），加上 `tsx` 的 IPC pipe 文件名后缀会超过 macOS unix-socket `sun_path` 104 字节上限，Bridge 首次监听即 `EINVAL: invalid argument` 崩溃——`TMPDIR=/tmp` 部署即可规避,与[[reference_qa_codex_lead_runtime_tmpdir_overlap]] 是同一类"QA runner 自己的运行时路径污染被测环境"的姐妹坑。

**GitHub secret-scanning push-protection 拦 sandbox push**：main 历史里的 fleet-provisioning 测试夹具用了真实形状的假 Discord/Slack/OpenAI token（用来测 sanitizer），推组合分支到 `flywheel-qa-sandbox` 时被拦。用 `git filter-repo --replace-text` 在**隔离的临时 clone**里把这些字符串替换成占位符再推（不碰真实 origin 历史/不碰本地工作分支）。

**验 `runPostShipFinalization` 的三件套（Linear Done / runner 自关闭 / thread 自动 Archive）别查太早**：`archiveChatThread` 是这条流水线里 notifier **之后**的最后一步（tmux cleanup → worktree cleanup → notifier → thread archive，见 `post-ship-finalization.ts` 严格顺序注释）。第一轮验完看到 `[linear-finalizer] ... → Done` 日志就立刻查 thread，Discord API 回 `archived:false`——不是真 bug，是查太早（archive 这一步还没轮到）。第二轮隔几秒再查，`archived:true`。以后验这条流水线，看到 Linear-Done 日志后**再等一拍**（或直接 grep `chat_thread_archived` 事件）才下结论；同理 `tmux list-windows` 复查 runner 自关闭也建议在同一时间点之后做。

**⚠️ 第三轮（真·全自动三段式，无人工模拟任何 phase 交付物）发现一个真结构性 bug，不是查太早**：`archiveChatThread` 本身成功了（本地 `chat_threads.archived_at` 有时间戳，是真证据），但**几秒后**再查 Discord API，`archived` 又变回 `false` 了——不是回归，是 Discord 自身行为：archive 之后 QA phase 的 runner **还活着**（tmux 窗口没关），它自己接着往同一个 thread 发了几条消息（`✅ QA PASS...`、`🎉 Ship 完成...`、标题改名），**给一个已 archive 的 thread 发消息会被 Discord 自动 unarchive**。根因往下查是 tmux 自关闭没触发：`postMergeTmuxCleanup` 靠 `getTmuxTargetFromCommDb` 从 `~/.flywheel/comm/<project>/comm.db` 的 `sessions` 表查 `tmux_window`，而这次三个 phase（design/implement/qa）在这张表里**完全没有行**——一路查到 `PhaseOrchestrator.onPhaseComplete()` 的 handoff 调用（`phase-orchestrator.ts` 里 `startDispatcher.start({..., leadId: prev.lead_id, ...})`）：`prev.lead_id` 读的是 `sessions` 表的 `lead_id` 列，但 **teamlead.db 的 `sessions` 表 schema 里根本没有 `lead_id` 这一列**（`sqlite3 .schema sessions` 实测确认，只有 `agent_name`/`agent_match_method`，跟 lead 分配无关）——所以 `prev.lead_id` 在每一次三段式 handoff 里**恒为 `undefined`**。`Blueprint.ts` 算 `commDbPath` 是 `ctx.leadId && ctx.projectName ? ... : undefined`，`leadId` 缺失 → `commDbPath` 恒为 `undefined` → `TmuxAdapter` 里 `if (ctx.commDbPath) { registerSession }` 整块跳过（静默,不报错不 warn）→ Implement/QA 这两个由 PhaseOrchestrator 自动交接出去的 phase runner，CommDB 里永远查不到它们的 tmux 窗口 → ship 完成时 `postMergeTmuxCleanup` 找不到 target，"not an error"，直接跳过关窗口。**这是可复现的结构性缺陷（不是这次 QA 环境的偶发artifact）**：任何走三段式 PhaseOrchestrator handoff 的 Implement/QA phase，ship 后 tmux 大概率都不会自关；这次连带把已成功的 Discord archive 又"撞开"了，是这个 bug 的下游可见症状，不是 archive 步骤本身的回归。修法方向：handoff 时给 `leadId` 一个真实来源（比如同 `runPostShipFinalization` 一样用 `resolveLeadForIssue(labels)` 现查，而不是指望一个不存在的 DB 列）。

**第四轮验证 FLY-856（`resolveLeadId` 修复）——CommDB 注册直接查表证实修好，但另一个独立问题挡住了完整 ship→finalization 观察**：合入 PR #442 后重新查 CommDB `sessions` 表，Implement/QA 两个 phase 的执行 id 这次都有真实 `tmux_window` 行了（round 3 时这张表对三个 phase 全是空的）——修复本身生效，直接数据证据，不是猜。但本轮的三段式 QA phase runner 自己用错了完成命令：调了 `flywheel-comm qa-result --status pass`（这是 **FLY-579 auto-QA 框架**给"验证 parent session"用的裁决上报，走 `auto-qa-coordinator.ts` 的 `onQaResult`，要求一个 `awaiting_review` 的 parent + 一条 `auto_qa_record`——跟三段式 pipeline 完全是两套机制），而不是三段式 QA phase 该用的 `complete --route needs_review --pr <N>`。结果三个 phase 的 `sessions.status` 全部直接落进终态 `completed`，从未经过 `awaiting_review`。

**事后没有 CLI 层面的补救路径，遇到就只能整轮重来**：①对已终态 session 手动重开 `gate approve_to_ship --no-block`——写得进去，但几秒内（GatePoller 3s 轮询）就被清掉，日志 `[GatePoller] evicting stale gate_question qid=...: source session terminal`（设计内行为，不是 bug：GatePoller 正确拒绝为终态 session 保留待批问题）。②真 merge PR 后对已终态 session 补发 `complete --route auto_approve --merged`——被 WorkflowFSM 拒绝：`Transition completed → completed is not allowed`（呼应 FLY-228 Finding K 的终态保护）。**验 ship-finalization 类机制，必须在 session 到达 `awaiting_review` 后立刻介入，错过这个窗口这条 session 就废了，没有回头路。**

**第五轮验证 FLY-859 Step 8（QA phase 自持 founder-gate + 自 ship）——完整链路真机跑通,附加发现**：

1. **抓 `awaiting_review` 窗口的稳妥手法**：与其人工反复轮询查 session status，更稳的做法是起一个后台 bash 脚本用 `until sqlite3 ... | grep -q .; do sleep 2; done` 轮询 comm.db 里 `checkpoint='approve_to_ship' AND from_agent=<目标 exec>`，一发现就在**同一个脚本内**立即 `respond`——省掉"轮询→通知我→我再手动查再手动 respond"这几轮来回的延迟，真正做到秒级响应。

2. **⚠️ 手动 `flywheel-comm respond` 报 `HTTP 401 unauthorized`，跟 `--db` 是同一类坑但换了个变量**：`approve_to_ship` 这类 checkpoint 走 `respond` 命令内部会自动路由去 Bridge（`--bridge-url` 或环境变量 `BRIDGE_URL`/`FLYWHEEL_BRIDGE_URL` 兜底）。如果不显式传 `--bridge-url`，会读到**自己 Runner 会话继承的 `FLYWHEEL_BRIDGE_URL`**（通常指向**生产** Bridge，端口 9876），批准请求打到了错误的 Bridge 上自然认证失败。**手动跑 `flywheel-comm respond` 时必须显式传 `--bridge-url http://localhost:<隔离 slot 端口>`，不能依赖继承的环境变量**——跟 `--db`/`--state-db` 的教训同源，凡是"可能从继承 env 兜底"的 flag，手动跑隔离测试时都要显式传。

3. **Step 8（QA phase 自持 gate）真机确认按设计工作**：QA runner 自己报 `qa-result --status pass` → 自己对**自己的** execution 开 `gate approve_to_ship --no-block` → 自己 `complete --route needs_review --pr N` 标 `awaiting_review` → 原地停下空等（不轮询）。日志实锤：`[phase-orch] three-stage QA PASS for <issue> (<exec>, target=<同一个 exec>) — QA runner proceeds to the founder ship gate`。跟 round 3/4 的旧模式（Implement phase 开 gate）不同，这是新设计，`target=` 后面的 exec id 应该跟发起 `qa-result` 的 exec id 一致，用这个当验证是否走对路径的锚点。

4. **完整 ship→finalization 这次真的全过了，包括 tmux 真自动关闭**：`tmux list-windows -a` 对该 issue 完全清空，甚至整个 tmux **session**（`runner-test-slot-2`）都被连带清空了（日志 `[tmux-viewer] kill viewer-session failed: ... can't find session` 恰好印证）。这是 FLY-856 fix 之后第一次真正观察到"ship 后 tmux 真的自己关掉"这个此前一直卡住没验完的点。

5. **⚠️ 新发现：archive 触发和 runner 真正退出之间有个时间窗口，runner 自己的收尾汇报消息会把刚 archive 的 thread 撞开**：Bridge 侧 `archiveChatThread` 确实成功执行过（`chat_threads.archived_at` 有时间戳），但 runner 自己在触发 ship 事件之后还会**继续跑一小段时间**做自己的收尾汇报（比如给 Lead 发一条"✅ 已 Ship..."的确认消息），这条消息比 Bridge 的 archive 晚了几十秒，把 thread 撞开，之后没有任何机制把它重新收回 archived。跟 round 3 表面症状一样（"archive 过了又被撞开"），但**根因不同**：round 3 是 tmux 压根没关（CommDB 洞，现已修复）；这次 tmux **真的关了**，纯粹是 archive 触发点和 runner 彻底停止说话之间有个真空期。验这条流水线要留意：即使 tmux confirmed 关闭 + archived_at 落库，也要**再等几十秒**重新查一次 Discord 的 `archived` 字段，不能只信本地记录的落库时间戳。

6. **合并新 PR 时，其他 PR 自带的测试如果早于新 PR 的 deps 变更，可能在合并后编译能过但测试内部悄悄失败**：本轮合并 FLY-859（#443）撞见两处这类问题——① FLY-859 自己新增的 `event-route-fly859-three-stage-qa.test.ts` 里手写的 `PhaseOrchestrator` mock 没跟上同一批合入的 FLY-856 新增字段 `resolveLeadId`，导致测试内部真实抛错但被 fail-closed 分支悄悄吞掉，断言察觉到的只是"结果是空的"，不是"抛出异常"——排查这类"预期长度不对"的失败，要往上游查一层"是不是内部真出错了、只是被吞掉"。② `stage-status-emoji.test.ts` 里三条断言早于 **FLY-795 自己 PR** 里改过的 `pr_created`/`approve` 徽章拆分（commit `830107f3`），是 FLY-795 自己 PR 遗留的既有测试缺口，跟当前改动无关，只是这次真跑 CI 才第一次暴露。**合并多个各自独立开发的 PR 之后，即使每个 PR 单独看都测试全绿，合并后也要重新跑一次完整测试套件**——大概率会挖出这类"测试没跟上另一个更早合并的行为变更"的既有缺口。

### Infra Findings
- **CommDB path**: `~/.flywheel/comm/{project}/comm.db` — may have WAL files (.db-wal, .db-shm). better-sqlite3 readonly mode handles this correctly.
- **Bridge E2E setup**: Use `/events` API with `session_started` event to create active sessions (not `/api/runs/start` which dispatches real Runner and fails without tmux).
- **GatePoller matching**: `question.from_agent` must exactly match `session.execution_id` in StateStore. Orphan questions are silently skipped.
- **GatePoller dedup**: Uses `isLeadEventDelivered` — only marks delivered on successful `runtime.deliver()`. Failed deliveries retry every poll cycle (3s).
- **StateStore is sql.js (in-memory)**: External sqlite3 CLI edits to disk DB file are NOT visible to Bridge process.

### Timeout Behavior
- After fix c3f2d0f: `--timeout N` accepts milliseconds directly (was ×1000 before fix).
- Poll loop now sleeps `min(pollInterval, remaining)` — no overshoot.
- `--timeout 5000` exits in ~5s (previously 83 min due to unit mismatch).

### Test Infrastructure
- bash E2E script at `tmp-qa-tests/e2e-gate.sh` — 13 tests, ~30s total runtime.
- Bridge E2E requires: PETER_BOT_TOKEN, DISCORD_GUILD_ID, TEAMLEAD_PORT=9877, TEAMLEAD_INGEST_TOKEN, TEAMLEAD_API_TOKEN.

### [HISTORICAL — fixed by FLY-47/77] P0 Bug: GatePoller → Lead Relay Broken (2026-04-06)
- **Root cause**: Discord plugin `server.ts` Line 852-855 filters ALL bot messages from reaching Lead agent
  - Line 852: `if (msg.author.id === client.user?.id) return` — self-message unconditional drop
  - Line 853-855: `if (msg.author.bot && !access.allowBots?.includes(msg.author.id)) return` — all other bots dropped when allowBots not configured
- **Impact**: Bridge uses per-lead bot token (PETER_BOT_TOKEN) for ClaudeDiscordRuntime. Same token as Peter's Discord plugin. Peter never sees control channel events.
- **access.json** at `~/.claude/channels/discord/access.json`: control channel IS registered in groups but `allowBots` is missing
- **Fix needed**: (1) Bridge should use CLAUDEBOT_TOKEN for control channel delivery, (2) access.json needs `allowBots` with ClaudeBot's user ID
- **Fix status (SHA 0c2d49f)**: (1) CLAUDEBOT_TOKEN fix verified ✅, (2) access.json still pending
- **Resolution**: FLY-47 (PR #119) 改用 CommDBLeadRuntime；FLY-77 (PR #TBD) 删除 ClaudeDiscordRuntime + CLAUDEBOT_TOKEN。Bridge → Lead 现走 CommDB file inbox + flywheel_inbox MCP，不再 post Discord 任何 channel。

### [HISTORICAL — control channel removed by FLY-77] GatePoller Chat Dedup Bug (2026-04-06)
- **Symptom**: Same gate question relayed to Discord chat every 3s poll cycle (20+ duplicates)
- **Root cause**: `postToChatChannel()` in `gate-poller.ts` L206 is called unconditionally in `relayToLead()`, outside the `markLeadEventDelivered` gate. If `runtime.deliver()` fails (control channel), `isLeadEventDelivered` stays false → every poll re-enters relay → chat message sent again.
- **Fix needed**: Either move `postToChatChannel` inside `if (result.delivered)` block, or add independent dedup for chat delivery.
- **Resolution**: FLY-47 / FLY-77 后无 control channel deliver 路径，dedup 问题随之消失。

### QA Testing Lessons
- **`/events` API payload must include `issueTitle`**: ForumPostCreator title comes from `payload.issueTitle`. Missing field → forum post title shows only `[FLY-QA-4]` without title text. This is correct behavior (not a bug) — the caller must provide the field.
- **`pnpm build` overwrites dist edits**: Manual debug logging in dist files is lost on rebuild. Use source edits + rebuild instead.
- **Key files**: `server.ts` (plugin), `plugin.js` Line 41 (token selection), `ProjectConfig.js` Line 118-121 (token resolution)

## 2026-04-17: FLY-108 (qa-fly-108)

### Infra Findings
- **`better-sqlite3` native binding absent in pnpm worktree**: `test-deploy.sh` hangs at "Lead ready within 120s" because inbox-mcp crashes on native require. Fix: copy `build/` dir from main repo or run `pnpm rebuild better-sqlite3` in worktree. `test-deploy.sh` should guard against this.
- **Bridge launched with `TEAMLEAD_DB_PATH=:memory:`**: blocks black-box verification of CIPHER `decision_snapshots` rows. AC-8 covered by unit test only. Future: switch test-slot to file-backed DB.
- **Bridge stdout not redirected**: `npm exec tsx run-bridge.ts &` with no log file — Bridge logs lost after shell exit. Can't grep PSF / EventFilter markers from QA. Recommend `>> ${SLOT_DIR}/bridge.log 2>&1`.
- **`/api/sessions` default `mode=active` filters completed**: Use `/api/sessions/<exec_id>` (direct lookup) to see completed sessions, not `/api/sessions` listing.
- **`close-runner` 409 is a PSF-absence signal**: If status=awaiting_review (not completed), close-runner returns 409 `status_not_eligible`. This is a clean black-box way to verify PSF did not fire (S5/AC-10 verification pattern).
- **`action approve` endpoint**: POST `/actions/approve` body `{"execution_id","identifier","leadId"}` (not `/api/actions`). `leadId` required when `checkLeadScope` is active.
- **FSM duplicate event response**: Duplicate `session_completed` with same terminal route returns HTTP 200 with `{"ok":true,"warning":"FSM rejected transition — event stored but session not updated"}`. Useful idempotency observable for S6/AC-11.
- **`flywheel-comm complete` retry timing**: ECONNREFUSED is instant (no 5s timeout per attempt). Actual elapsed for 4 attempts with Bridge down = 1+2+4 = 7s (backoff sum only). Plan's 27s assumption was wrong. Marker payload schema: `{execution_id, attempts, error, timestamp, event_id, issue_id, project_name, event_type, source, payload}`.
- **Bridge guard warning shape**: `POST /events` with invalid route returns HTTP 200 + `{"ok":true,"warning":"invalid route skipped"}`. Status stays in `running` (no silent flip).

### Chrome Discord observations (FLY-108)
- Lead (flywheel-test-2) in #lead-test-1 posted distinct messages per route:
  - `auto_approve` → `[<ISSUE>] 已 ship | Route | Summary | Commits | PR | Shipped at`
  - `needs_review` → `[<ISSUE>] 需要你 review | Status: awaiting_review | Route`
  - `session_started` → `[<ISSUE>] Runner 开始跑了 | Title | Execution ID | Status: running | Started at`
- Lead explicitly flagged duplicate detection: "去重机制看起来工作正常（否则应该看到两次 completed）" — qualitative AC-11 confirmation.

### PR #155 Result
All 6 scenarios PASS (S4 deferred to unit test due to :memory: DB). See `doc/qa/reports/v1.23.0-FLY-108-qa-report.md`. Recommendation: SHIP.

## 2026-04-19: FLY-108 Round 2 (qa-fly-108) — Real Runner E2E via FLY-115 framework

### New framework findings (v1.24.0 → v1.24.1 → v1.24.2 pending)

- **Tail pipe SIGPIPE kills Runner start**: `test-deploy.sh` piped Runner output through `tee | head -n 1000` — Runner hung at > 1000 lines. Fixed in v1.24.1 (redirect to `${SLOT_DIR}/runner.log` with no pipe).
- **Trust prompt blocks first-run Runner**: Claude Code CLI first-run "Trust this folder?" prompt was invisible in detached tmux. Fixed in v1.24.1 (`--dangerously-skip-permissions` + auto-ack).
- **Teardown `:memory:` DB drop-table error**: `test-teardown.sh` tried to drop tables after Bridge exited — `no such database` error. Fixed in v1.24.1 (conditional skip).
- **`botToken=MISSING` blocks Discord product observation**: slot Bridge has no per-slot bot token + `chatThreads=false` + `threadId=none` → `DirectEventSink.updateTag` skips with `no_thread` result. Blocks S5 🏁 / review-request Chrome Discord observation. Pending v1.24.2.
- **Sandbox auto-merge not wired**: Runner writes `land-status.json` with `status=ready_to_merge`, but sandbox PR stays OPEN — no webhook simulator. Blocks full `completed` transition + `close-runner 200` observation. Pending v1.24.2.
- **`session_events.payload` empty for session_started/completed** (while stage_changed payloads stored): observational; functional impact zero (FSM + DirectEventSink consumed payload correctly upstream). Flag for future awareness.

### Real Runner flow confirmed working

- `flywheel-comm stage` split from `flywheel-comm complete` (FLY-108 design) works: stage events carry `{"stage":"pr_created"}` / `{"stage":"completed"}`, session_completed fires only at terminal.
- Real Runner populated `pr_number`, `status=awaiting_review`, `session_stage=completed` correctly in the `sessions` table.
- Bridge `DirectEventSink.pushNotification` + `EventFilter` correctly classified `session_completed` with `priority=high`, `updateForum=true`.
- `land-status.json` at `.flywheel/runs/<exec_id>/land-status.json` is the Runner's ready-to-merge signal.
- `IdleWatchdog` emits `runner_idle_detected` after 90s stall — expected cadence, not a bug.

### Round 2 verdict
**API-level PASS** — GEO-362 (empty payload) + GEO-363 (event never fires) both confirmed fixed end-to-end with real Runner. **Product-level deferred to Round 3** after v1.24.2 unlocks Discord + auto-merge gaps. Report: `doc/qa/reports/v1.24.0-FLY-108-round2-qa-report.md`.

## 2026-06-01: FLY-188 — 截图证据怎么落盘可 commit（QA / 设计验证 agent 必读）

**背景（GEO-386 真实踩坑）**：QA agent 用 **claude-in-chrome** 跑前端 E2E 时，`computer` 工具的截图（即使 `save_to_disk:true`）**只回一个 imageId、不在 agent 本地磁盘产任何文件** —— 图存在浏览器扩展内存里，只能被 `upload_image` 喂进网页表单，**没法 `Read`/`cp`/`git add` 当证据**。这是工具的设计边界（截图本就是给 agent inline 看的），不是 bug。

> **铁律**：绝不要把「我截了图看到了」当成「证据已落盘」。「看见」和「证据落盘可核验」是两条独立通道。

### 按「截图想干嘛」三分流（主路 = claude-in-chrome gif download）

| 场景 | 走法 | 产物 | founder 实时看 |
|---|---|---|---|
| 只为 agent 自己判断（多数中间步骤） | `computer` screenshot（**不设** save_to_disk） | 无（inline，够用，别纠结落盘） | ✅ 顺带看得到 |
| **要可 commit 证据（绝大多数 QA / 设计验证）→ 主路** | **claude-in-chrome `gif_creator` 录制 → `export download:true` → `mv ~/Downloads/<file>.gif` 进 repo**（见 Recipe MAIN） | GIF（含单帧/短流程） | ✅ 在她**日常 Chrome**全程看 |
| Fallback：① 非交互 Runner 自检流水线（没人看、要结构化 PNG/WebM/SUMMARY + PR 直发）② 要真彩 PNG/视频（3D 保真、像素级对比） | `flywheel-comm visual-capture`（ProofShot）/ `agent-browser`（见 Recipe FALLBACK） | PNG/WebM | ❌（独立浏览器） |

> **为什么 gif download 是主路**：它是 **claude-in-chrome 唯一能落本地盘的原生出口**（`computer save_to_disk` 只回 imageId、不产文件），而 claude-in-chrome 正是大家日常用的工具 —— 不用换工具、founder 在她自己 Chrome 里全程实时看、带她的登录态、录的是真实渲染（含 WebGL 合成画面）。agent-browser 是独立浏览器、没登录态、看不到实时画面，所以**降为 fallback**，只在下面两个触发条件用。

### Recipe MAIN — claude-in-chrome gif download（FLY-188 实测 PASS）

**关键实测细节（务必照做，否则录到 0 帧）**：`gif_creator` 的帧来自**状态变化动作**（navigate / click / scroll / type），**不来自单纯 `computer` screenshot**（光截一张 = "Captured 0 frames"）。所以顺序必须是 **先 `start_recording`、再 navigate 到目标页 + 做要验证的 UI 操作**（这些才被录成帧），最后 stop + export。对「纯静态单屏、零交互」的极端情况，至少要在录制中 navigate 一次或 scroll 一下来产帧。这正是自然的 QA 流程：边操作边录。

```
# claude-in-chrome MCP 工具（不是 shell）：
1. tabs_context_mcp                 # 只读看现有 tab，绝不碰 founder 现有 tab
2. tabs_create_mcp                  # 开你自己的新 tab（或 createIfEmpty 起隔离 group）
3. gif_creator  action=start_recording  tabId=<你的 tab>     # ← 先开录
4. navigate <目标前端 url>  tabId=<你的 tab>                  # navigate 是动作 → 产帧
   computer  action=click/scroll/type ...                    # 跑要验证的 UI 步骤 → 每步产帧
   （可穿插 computer screenshot 给自己看，但 screenshot 本身不产帧）
5. gif_creator  action=stop_recording  tabId=<你的 tab>       # 会报 "Captured N frames"
6. gif_creator  action=export  download=true  tabId=<你的 tab> \
        filename="<ISSUE>-<scenario>-<YYYYMMDD-HHMMSS>.gif"   # 落 ~/Downloads
7. mv ~/Downloads/<ISSUE>-<scenario>-<ts>.gif  doc/qa/reports/<run>/  &&  git add   # commit 证据
8. tabs_close_mcp <你的 tab>        # 用完还原，founder Chrome / 现有 tab 全程不碰
```

- **唯一硬伤：只能出 GIF（256 色），不能出 PNG/视频。** UI 流程足够；3D/WebGL 富色彩场景会有色带、保真度差 —— 那种要真彩就走 Fallback。
- **唯一命名**：`~/Downloads` 是全局共享落点，多 agent 并发会撞名 → 文件名一律 `<ISSUE>-<scenario>-<YYYYMMDD-HHMMSS>.gif`，截完立即 `mv` 进 repo（别堆在 ~/Downloads）。
- **export `options`** 可关 overlay（`showClickIndicators`/`showWatermark` 等默认 true）；要干净证据就关，要展示交互就留。

### Recipe FALLBACK — agent-browser / ProofShot（独立 Chromium，**不碰 Annie 的日常 Chrome**）

**只在这两种情况用**（否则用 Recipe MAIN）：① 非交互 Runner 自检流水线（没人现场看、要结构化 PNG/WebM/SUMMARY + `proofshot pr` 直发）；② 要真彩 PNG/视频（3D 保真、像素级对比 —— gif 256 色不够）。
> 注意：**WebGL 本身不是换工具的理由** —— claude-in-chrome 能截 WebGL 合成画面。3D 走 fallback 的真正原因是 gif 的 256 色调色板会让富色彩 3D 出色带，需要真彩 PNG。

```bash
# ── 简单 ad-hoc ──
# 持久 profile：登录态跨 run 留存（首次需登一次）
AGENT_BROWSER_PROFILE=~/.flywheel-qa-profile agent-browser open https://<url>
agent-browser screenshot /abs/path/in/repo/doc/qa/reports/<run>/step.png   # 真 PNG，可 git add
agent-browser close

# ── Runner pipeline 内（经 flywheel-comm visual-capture / ProofShot）──
# 注意：visual-capture 是给 Runner 自检流用的，--exec-id/--issue-id/
# --project-name/--stage/--dedup-key 由 Runner 上下文提供(部分可读 FLYWHEEL_* env)，
# **不是可省的**；手测请用上面的直接 agent-browser 路径。
flywheel-comm visual-capture --kind ui --dev-command "pnpm dev" \
  --output ~/.flywheel/qa-shots/<run> \
  --exec-id "$FLYWHEEL_EXEC_ID" --issue-id "$FLYWHEEL_ISSUE_ID" \
  --project-name "$FLYWHEEL_PROJECT_NAME" --stage test \
  --dedup-key "${FLYWHEEL_EXEC_ID}|test|ui" \
  --agent-browser-profile ~/.flywheel-qa-profile   # 持久 profile：登录态跨 run 留存
```

- **登录态变体**：`--profile Default`（或 agent-browser `--profile "Default"`）会**只读快照 Annie 真 Chrome profile 的登录态**（cookie/已登录会话），**不动她的原 profile** —— 适合要测登录后页面（如 GEO-386 的 studio）。持久自定义目录（如 `~/.flywheel-qa-profile`）则把登录态留在该目录跨 run。
- **stream 直播观看是 follow-up**（本期 defer）：`visual-capture --agent-browser-stream-port <n>` / `agent-browser stream enable` 能起 WebSocket 流让 Annie「pair browsing」实时看，但本期只留 env 透传钩子、未深入接，后续单独做。

### ⚠️ Recipe A（连 Annie 真 Chrome via CDP）—— 实测**不可行**，别用

`agent-browser --auto-connect`/`--cdp 9222` 连她日常 Chrome：实测失败（Chrome 144+ HTTP `/json` 禁用 + 无 `--remote-allow-origins` 启动 → 外部 CDP 连不上）。要 work 必须用 debug flag **重启她的 Chrome**（关掉她所有 tab）—— 不值得。要实时看 + 可 commit，**用 Recipe MAIN（gif download）**。详见 `doc/engineer/research/new/FLY-188-claude-in-chrome-screenshot-persistence.md`。
