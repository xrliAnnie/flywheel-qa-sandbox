# QA Context — Flywheel

Accumulated QA knowledge across sessions. Read at onboard, write at finalize.

## 2026-04-05: FLY-47 + FLY-62 (qa-fly-47)

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
