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
