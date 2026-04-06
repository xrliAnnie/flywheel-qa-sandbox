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

### P0 Bug: GatePoller → Lead Relay Broken (found 2026-04-06)
- **Root cause**: Discord plugin `server.ts` Line 852-855 filters ALL bot messages from reaching Lead agent
  - Line 852: `if (msg.author.id === client.user?.id) return` — self-message unconditional drop
  - Line 853-855: `if (msg.author.bot && !access.allowBots?.includes(msg.author.id)) return` — all other bots dropped when allowBots not configured
- **Impact**: Bridge uses per-lead bot token (PETER_BOT_TOKEN) for ClaudeDiscordRuntime. Same token as Peter's Discord plugin. Peter never sees control channel events.
- **access.json** at `~/.claude/channels/discord/access.json`: control channel IS registered in groups but `allowBots` is missing
- **Fix needed**: (1) Bridge should use CLAUDEBOT_TOKEN for control channel delivery, (2) access.json needs `allowBots` with ClaudeBot's user ID
- **Fix status (SHA 0c2d49f)**: (1) CLAUDEBOT_TOKEN fix verified ✅, (2) access.json still pending

### GatePoller Chat Dedup Bug (found 2026-04-06)
- **Symptom**: Same gate question relayed to Discord chat every 3s poll cycle (20+ duplicates)
- **Root cause**: `postToChatChannel()` in `gate-poller.ts` L206 is called unconditionally in `relayToLead()`, outside the `markLeadEventDelivered` gate. If `runtime.deliver()` fails (control channel), `isLeadEventDelivered` stays false → every poll re-enters relay → chat message sent again.
- **Fix needed**: Either move `postToChatChannel` inside `if (result.delivered)` block, or add independent dedup for chat delivery.

### QA Testing Lessons
- **`/events` API payload must include `issueTitle`**: ForumPostCreator title comes from `payload.issueTitle`. Missing field → forum post title shows only `[FLY-QA-4]` without title text. This is correct behavior (not a bug) — the caller must provide the field.
- **`pnpm build` overwrites dist edits**: Manual debug logging in dist files is lost on rebuild. Use source edits + rebuild instead.
- **Key files**: `server.ts` (plugin), `plugin.js` Line 41 (token selection), `ProjectConfig.js` Line 118-121 (token resolution)
